import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseFrontmatter } from "../lib/agentbus.mjs";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..", "..");

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition, { timeoutMs, pollMs }) {
  const started = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

test("dummy-worker: closes tasks without manual prompts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "valua-agent-dummy-"));
  const busRoot = path.join(tmp, "bus");
  const rosterPath = path.join(tmp, "ROSTER.json");

  await fs.writeFile(
    rosterPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        sessionName: "valua-cockpit-test",
        orchestratorName: "daddy-orchestrator",
        daddyChatName: "daddy",
        agents: [
          { name: "daddy", kind: "codex-chat", role: "daddy-chat" },
          { name: "daddy-orchestrator", kind: "node-worker", role: "orchestrator-worker" },
          { name: "frontend", kind: "codex-worker", role: "codex-worker" },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const nodeBin = process.execPath;
  const agentBus = path.join(repoRoot, "scripts", "agent-bus.mjs");
  const dummyWorker = path.join(repoRoot, "scripts", "agent-dummy-worker.mjs");

  await new Promise((resolve, reject) => {
    const child = spawn(
      nodeBin,
      [agentBus, "init", "--bus-root", busRoot, "--roster", rosterPath],
      { cwd: repoRoot, stdio: "inherit", env: process.env },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`agent-bus init exited ${code}`));
    });
  });

  const worker = spawn(
    nodeBin,
    [
      dummyWorker,
      "--agent",
      "frontend",
      "--bus-root",
      busRoot,
      "--roster",
      rosterPath,
      "--poll-ms",
      "25",
    ],
    { cwd: repoRoot, stdio: "ignore", env: process.env },
  );
  const workerExited = new Promise((resolve) => worker.once("exit", resolve));

  try {
    const taskId = "20260119T000000Z__dummy-worker-e2e";
    const taskFile = path.join(tmp, `${taskId}.md`);
    await fs.writeFile(
      taskFile,
      [
        "---",
        JSON.stringify(
          {
            id: taskId,
            to: ["frontend"],
            from: "daddy",
            priority: "P2",
            title: "Dummy worker e2e",
          },
          null,
          0,
        ),
        "---",
        "",
        "# Task: Dummy worker e2e",
        "",
        "Close this task.",
        "",
      ].join("\n"),
      "utf8",
    );

    await new Promise((resolve, reject) => {
      const child = spawn(
        nodeBin,
        [
          agentBus,
          "send",
          taskFile,
          "--bus-root",
          busRoot,
          "--roster",
          rosterPath,
        ],
        { cwd: repoRoot, stdio: "inherit", env: process.env },
      );
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve(undefined);
        else reject(new Error(`agent-bus send exited ${code}`));
      });
    });

    const processed = path.join(busRoot, "inbox", "frontend", "processed", `${taskId}.md`);
    const receipt = path.join(busRoot, "receipts", "frontend", `${taskId}.json`);
    const orchInbox = path.join(busRoot, "inbox", "daddy-orchestrator", "new");

    await waitFor(
      async () => {
        if (!(await fileExists(receipt))) return false;
        try {
          const files = (await fs.readdir(orchInbox)).filter((f) => f.endsWith(".md"));
          return files.length > 0;
        } catch {
          return false;
        }
      },
      { timeoutMs: 2000, pollMs: 25 },
    );

    assert.equal(await fileExists(processed), true);

    const receiptJson = JSON.parse(await fs.readFile(receipt, "utf8"));
    assert.equal(receiptJson.taskId, taskId);
    assert.equal(receiptJson.agent, "frontend");
    assert.equal(receiptJson.outcome, "done");
    assert.ok(typeof receiptJson.note === "string" && receiptJson.note.startsWith("dummy completed:"), receiptJson.note);
    assert.ok(typeof receiptJson.commitSha === "string" && receiptJson.commitSha.length >= 6);

    // Assert a TASK_COMPLETE packet exists for the orchestrator.
    const completionFiles = (await fs.readdir(orchInbox)).filter((f) => f.endsWith(".md"));
    const completionPackets = await Promise.all(
      completionFiles.map(async (f) => ({ f, raw: await fs.readFile(path.join(orchInbox, f), "utf8") })),
    );
    const parsed = completionPackets
      .map(({ raw }) => {
        try {
          return parseFrontmatter(raw).meta;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    assert.ok(
      parsed.some((meta) => meta?.signals?.kind === "TASK_COMPLETE" && meta?.signals?.completedTaskId === taskId),
      "expected TASK_COMPLETE packet in orchestrator inbox",
    );
  } finally {
    worker.kill("SIGTERM");
    await Promise.race([
      workerExited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("worker did not exit")), 1000),
      ),
    ]);
  }
});
