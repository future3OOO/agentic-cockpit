#!/usr/bin/env node

import fs from 'node:fs';

import {
  resolveWorkerRuntimeWorkdir,
  validateCodexWorkerDedicatedWorkdir,
  validateDedicatedAgentWorkdir,
} from '../lib/agent-workdir.mjs';

function readRoster(rosterPath) {
  const raw = fs.readFileSync(rosterPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`invalid runtime roster JSON: ${rosterPath} (${message})`);
  }
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readAutopilot(roster, rosterPath) {
  const agents = Array.isArray(roster.agents) ? roster.agents : [];
  const autopilotName = trim(roster.autopilotName) || 'daddy-autopilot';
  const autopilot = agents.find(
    (agent) =>
      agent &&
      trim(agent.name) === autopilotName &&
      trim(agent.kind) === 'codex-worker',
  );
  if (!autopilot) {
    throw new Error(`roster validation failed: missing codex-worker '${autopilotName}' in ${rosterPath}`);
  }
  return { autopilotName, autopilot, agents };
}

function printUsageAndExit() {
  process.stderr.write(
    [
      'Usage:',
      '  node scripts/agentic/valua-restart-master-roster.mjs validate-autopilot <rosterPath> <worktreesDir> <sourceRoot> <runtimeRoot>',
      '  node scripts/agentic/valua-restart-master-roster.mjs list-runtime-targets <rosterPath> <sourceRoot> <worktreesDir>',
    ].join('\n') + '\n',
  );
  process.exit(2);
}

function formatValidationDetails(validation) {
  return [
    `raw workdir: ${validation.rawWorkdir || '<empty>'}`,
    `resolved workdir: ${validation.resolvedWorkdir}`,
    `reason: ${validation.reasonCode}`,
  ];
}

function cmdValidateAutopilot(argv) {
  if (argv.length < 4) printUsageAndExit();
  const [rosterPath, worktreesDir, sourceRoot, runtimeRoot] = argv;
  const roster = readRoster(rosterPath);
  const { autopilotName, autopilot } = readAutopilot(roster, rosterPath);
  const validation = validateDedicatedAgentWorkdir({
    agentName: autopilotName,
    rawWorkdir: autopilot.workdir,
    repoRoot: sourceRoot,
    runtimeRoot,
    worktreesDir,
  });
  if (!validation.ok) {
    process.stderr.write(
      [
        `ERROR: roster validation failed for ${autopilotName} dedicated worktree wiring.`,
        `roster:           ${rosterPath}`,
        `worktrees root:   ${worktreesDir}`,
        `source root:      ${sourceRoot}`,
        `runtime root:     ${runtimeRoot}`,
        ...formatValidationDetails(validation).map((line) => `detail:           ${line}`),
        'Expected:         explicit dedicated codex-worker workdir under the configured worktrees root',
        'Unset workdirs and source-root aliases are rejected because the worker would boot from the source checkout.',
      ].join('\n') + '\n',
    );
    process.exit(1);
  }
}

function cmdListRuntimeTargets(argv) {
  if (argv.length < 3) printUsageAndExit();
  const [rosterPath, sourceRoot, worktreesDir] = argv;
  const roster = readRoster(rosterPath);
  const agents = Array.isArray(roster.agents) ? roster.agents : [];
  for (const agent of agents) {
    const kind = trim(agent?.kind);
    if (!agent || (kind !== 'codex-worker' && kind !== 'codex-chat')) continue;
    const name = trim(agent.name);
    if (!name) continue;
    const branch = trim(agent.branch) || `agent/${name}`;
    let workdir = '';
    if (kind === 'codex-worker') {
      const validation = validateCodexWorkerDedicatedWorkdir({
        agentName: name,
        rawWorkdir: agent.workdir,
        repoRoot: sourceRoot,
        worktreesDir,
      });
      if (!validation.ok) {
        throw new Error(
          [
            `roster target resolution failed for ${name}`,
            ...formatValidationDetails(validation),
            'codex-worker agents must declare an explicit dedicated workdir under the configured worktrees root',
          ].join(' | '),
        );
      }
      workdir = validation.resolvedWorkdir;
    } else {
      workdir = resolveWorkerRuntimeWorkdir(agent.workdir, { repoRoot: sourceRoot, worktreesDir });
    }
    process.stdout.write(`${name}\t${branch}\t${workdir}\n`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'validate-autopilot') {
  cmdValidateAutopilot(rest);
} else if (command === 'list-runtime-targets') {
  cmdListRuntimeTargets(rest);
} else {
  printUsageAndExit();
}
