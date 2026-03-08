#!/usr/bin/env node
/**
 * Initialize a downstream project for Agentic Cockpit.
 *
 * This scaffolds:
 * - docs/agentic/agent-bus/*
 * - docs/agentic/BLUEPRINT.md
 * - docs/runbooks/*
 * - .codex/skills/cockpit-<name>/SKILL.md
 * - (optional) AGENTS.md
 *
 * Safety: by default this command does NOT overwrite existing files.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    projectRoot: null,
    force: false,
    withAgentsMd: false,
    skipRunbooks: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
      continue;
    }
    if (a === '--project' || a === '--project-root') {
      const v = argv[i + 1];
      if (!v) die(`${a} requires a path`);
      out.projectRoot = v;
      i += 1;
      continue;
    }
    if (a === '--force') {
      out.force = true;
      continue;
    }
    if (a === '--with-agents-md') {
      out.withAgentsMd = true;
      continue;
    }
    if (a === '--skip-runbooks') {
      out.skipRunbooks = true;
      continue;
    }
    if (!out.projectRoot && !String(a).startsWith('-')) {
      out.projectRoot = a;
      continue;
    }
    die(`Unknown arg: ${a}`);
  }

  return out;
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function copyFileSafe({ src, dest, force }) {
  await ensureDir(path.dirname(dest));
  if (!force && (await pathExists(dest))) return { copied: false, skipped: true, reason: 'exists' };
  await fs.copyFile(src, dest);
  return { copied: true, skipped: false, reason: null };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      [
        'Usage:',
        '  node scripts/init-project.mjs --project /path/to/project',
        '',
        'Options:',
        '  --force           Overwrite existing files',
        '  --with-agents-md  Also write a starter AGENTS.md into the project (if missing)',
        '  --skip-runbooks   Skip docs/runbooks bootstrap files',
        '',
      ].join('\n') + '\n',
    );
    return;
  }

  if (!args.projectRoot) die('Missing project root (pass --project /path or positional path)');

  const cockpitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const projectRoot = path.resolve(args.projectRoot);

  if (!(await pathExists(projectRoot))) die(`Project path does not exist: ${projectRoot}`);

  const srcBusDocs = path.join(cockpitRoot, 'docs', 'agentic', 'agent-bus');
  const destBusDocs = path.join(projectRoot, 'docs', 'agentic', 'agent-bus');

  const files = [
    'ROSTER.json',
    'PROTOCOL.md',
    'TASK_TEMPLATE.md',
    'CODEX_WORKER_OUTPUT.schema.json',
    'OPUS_CONSULT_REQUEST.schema.json',
    'OPUS_CONSULT_RESPONSE.schema.json',
    'OPUS_CONSULT.provider.schema.json',
  ];

  await ensureDir(destBusDocs);
  const results = [];
  for (const f of files) {
    const src = path.join(srcBusDocs, f);
    const dest = path.join(destBusDocs, f);
    if (!(await pathExists(src))) die(`Missing cockpit template file: ${src}`);
    results.push({ kind: 'bus-doc', file: path.relative(projectRoot, dest), ...(await copyFileSafe({ src, dest, force: args.force })) });
  }

  const srcBlueprint = path.join(cockpitRoot, 'docs', 'agentic', 'BLUEPRINT.md');
  const destBlueprint = path.join(projectRoot, 'docs', 'agentic', 'BLUEPRINT.md');
  if (!(await pathExists(srcBlueprint))) die(`Missing cockpit template file: ${srcBlueprint}`);
  results.push({
    kind: 'agentic-doc',
    file: path.relative(projectRoot, destBlueprint),
    ...(await copyFileSafe({ src: srcBlueprint, dest: destBlueprint, force: args.force })),
  });

  if (!args.skipRunbooks) {
    const srcRunbooksRoot = path.join(cockpitRoot, 'docs', 'runbooks');
    const destRunbooksRoot = path.join(projectRoot, 'docs', 'runbooks');
    if (!(await pathExists(srcRunbooksRoot))) die(`Missing cockpit runbooks dir: ${srcRunbooksRoot}`);
    await ensureDir(destRunbooksRoot);
    const runbookEntries = await fs.readdir(srcRunbooksRoot, { withFileTypes: true });
    for (const ent of runbookEntries) {
      if (!ent.isFile()) continue;
      const src = path.join(srcRunbooksRoot, ent.name);
      const dest = path.join(destRunbooksRoot, ent.name);
      results.push({
        kind: 'runbook',
        file: path.relative(projectRoot, dest),
        ...(await copyFileSafe({ src, dest, force: args.force })),
      });
    }
  }

  const srcSkillsRoot = path.join(cockpitRoot, '.codex', 'skills');
  const destSkillsRoot = path.join(projectRoot, '.codex', 'skills');
  await ensureDir(destSkillsRoot);

  let skillDirs = [];
  try {
    skillDirs = await fs.readdir(srcSkillsRoot, { withFileTypes: true });
  } catch {
    die(`Missing cockpit skills dir: ${srcSkillsRoot}`);
  }

  for (const ent of skillDirs) {
    if (!ent.isDirectory()) continue;
    const skillName = ent.name;
    if (!skillName.startsWith('cockpit-') && skillName !== 'code-change-verification') continue;

    const src = path.join(srcSkillsRoot, skillName, 'SKILL.md');
    const dest = path.join(destSkillsRoot, skillName, 'SKILL.md');
    if (!(await pathExists(src))) die(`Missing cockpit skill file: ${src}`);
    results.push({ kind: 'skill', file: path.relative(projectRoot, dest), ...(await copyFileSafe({ src, dest, force: args.force })) });

    // Copy optional skill-local scripts (best-effort).
    const srcScriptsDir = path.join(srcSkillsRoot, skillName, 'scripts');
    if (await pathExists(srcScriptsDir)) {
      let scripts = [];
      try {
        scripts = await fs.readdir(srcScriptsDir, { withFileTypes: true });
      } catch {
        scripts = [];
      }
      for (const s of scripts) {
        if (!s.isFile()) continue;
        const srcScript = path.join(srcScriptsDir, s.name);
        const destScript = path.join(destSkillsRoot, skillName, 'scripts', s.name);
        results.push({
          kind: 'skill-script',
          file: path.relative(projectRoot, destScript),
          ...(await copyFileSafe({ src: srcScript, dest: destScript, force: args.force })),
        });
      }
    }
  }

  const srcOpusRoot = path.join(cockpitRoot, '.codex', 'opus');
  const destOpusRoot = path.join(projectRoot, '.codex', 'opus');
  if (await pathExists(srcOpusRoot)) {
    await ensureDir(destOpusRoot);
    const opusEntries = await fs.readdir(srcOpusRoot, { withFileTypes: true });
    for (const ent of opusEntries) {
      if (!ent.isFile()) continue;
      const src = path.join(srcOpusRoot, ent.name);
      const dest = path.join(destOpusRoot, ent.name);
      results.push({
        kind: 'opus-guide',
        file: path.relative(projectRoot, dest),
        ...(await copyFileSafe({ src, dest, force: args.force })),
      });
    }
  }

  if (args.withAgentsMd) {
    const src = path.join(cockpitRoot, 'AGENTS.md');
    const dest = path.join(projectRoot, 'AGENTS.md');
    results.push({ kind: 'agents-md', file: path.relative(projectRoot, dest), ...(await copyFileSafe({ src, dest, force: args.force })) });
  }

  const copied = results.filter((r) => r.copied).length;
  const skipped = results.filter((r) => r.skipped).length;
  process.stdout.write(`OK: initialized project for Agentic Cockpit\n`);
  process.stdout.write(`  projectRoot: ${projectRoot}\n`);
  process.stdout.write(`  copied: ${copied}\n`);
  process.stdout.write(`  skipped: ${skipped}\n`);
  if (skipped) {
    process.stdout.write('\nSkipped (already exists):\n');
    for (const r of results.filter((x) => x.skipped)) {
      process.stdout.write(`- ${r.kind}: ${r.file}\n`);
    }
  }
}

main().catch((err) => {
  die((err && err.stack) || String(err));
});
