import { getPreflightOutputSchema } from './worker-preflight.mjs';

function parsePreflightOutput({ raw, threadId, label, createTurnError }) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw createTurnError(`${label} output parse failed: ${(err && err.message) || String(err)}`, {
      exitCode: 1,
      stderrTail: '',
      stdoutTail: raw.slice(-16_000),
      threadId: threadId || null,
    });
  }
}

export async function runPreflightCodexTurn({
  fs,
  outputPath,
  agentName,
  taskId,
  busRoot,
  writePane,
  writeTaskSession,
  runCodexAppServer,
  createTurnError,
  logLine,
  label,
  prompt,
  codexBin,
  repoRoot,
  taskCwd,
  schemaPath,
  guardEnv,
  codexHomeEnv,
  autopilotDangerFullAccess,
  openedPath,
  taskStatMtimeMs,
  resumeSessionId,
}) {
  try {
    await fs.rm(outputPath, { force: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (logLine) {
    writePane(logLine);
  }
  const result = await runCodexAppServer({
    codexBin,
    repoRoot,
    workdir: taskCwd,
    schemaPath,
    outputSchemaOverride: getPreflightOutputSchema(),
    outputPath,
    prompt,
    watchFilePath: openedPath,
    watchFileMtimeMs: taskStatMtimeMs,
    resumeSessionId,
    reviewGate: null,
    extraEnv: { ...guardEnv, ...codexHomeEnv },
    dangerFullAccess: autopilotDangerFullAccess,
  });
  let nextResumeSessionId = resumeSessionId || null;
  let nextLastCodexThreadId = resumeSessionId || null;
  if (result?.threadId && typeof result.threadId === 'string') {
    nextResumeSessionId = result.threadId;
    nextLastCodexThreadId = result.threadId;
    await writeTaskSession({ busRoot, agentName, taskId, threadId: result.threadId });
  }
  const raw = await fs.readFile(outputPath, 'utf8');
  return {
    raw,
    parsed: parsePreflightOutput({
      raw,
      threadId: result?.threadId,
      label,
      createTurnError,
    }),
    threadId: result?.threadId || null,
    resumeSessionId: nextResumeSessionId,
    lastCodexThreadId: nextLastCodexThreadId,
  };
}
