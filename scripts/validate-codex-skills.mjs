#!/usr/bin/env node
/**
 * Validate that all Codex skills in .codex/skills/<skill>/SKILL.md have YAML frontmatter
 * with at least: name, description.
 *
 * This is intentionally a tiny validator (no YAML deps) to keep the cockpit portable.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

function writeStdout(text) {
  return new Promise((resolve) => process.stdout.write(text, resolve));
}

function writeStderr(text) {
  return new Promise((resolve) => process.stderr.write(text, resolve));
}

function parseFrontmatter(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== '---') return { fm: null, bodyStart: 0 };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { fm: null, bodyStart: 0 };

  const fmLines = lines.slice(1, end);
  const fm = {};
  for (const line of fmLines) {
    const m = /^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return { fm, bodyStart: end + 1 };
}

async function main() {
  const repoRoot = process.cwd();
  const skillsRoot = path.join(repoRoot, '.codex', 'skills');

  let entries = [];
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    await writeStderr(`ERROR: missing skills dir: ${skillsRoot}\n`);
    process.exitCode = 1;
    return;
  }

  const errors = [];
  const warnings = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    const skillMd = path.join(skillsRoot, name, 'SKILL.md');
    let raw = '';
    try {
      raw = await fs.readFile(skillMd, 'utf8');
    } catch {
      errors.push(`${name}: missing SKILL.md`);
      continue;
    }

    const { fm } = parseFrontmatter(raw);
    if (!fm) {
      errors.push(`${name}: missing YAML frontmatter (--- ... ---)`);
      continue;
    }
    if (!fm.name) errors.push(`${name}: frontmatter missing "name"`);
    if (!fm.description) errors.push(`${name}: frontmatter missing "description"`);

    if (fm.name && fm.name !== name) {
      warnings.push(`${name}: frontmatter name "${fm.name}" does not match folder name`);
    }
  }

  if (warnings.length) {
    await writeStderr(`WARN:\n- ${warnings.join('\n- ')}\n\n`);
  }
  if (errors.length) {
    await writeStderr(`FAIL:\n- ${errors.join('\n- ')}\n`);
    process.exitCode = 2;
    return;
  }

  await writeStdout('OK: all skills have YAML frontmatter with name+description\n');
}

main().catch((err) => {
  process.exitCode = 1;
  // Best-effort: flush error text so tests/CI capture it reliably (stdio may be a pipe).
  writeStderr(`ERROR: ${(err && err.stack) || String(err)}\n`).catch(() => {});
});
