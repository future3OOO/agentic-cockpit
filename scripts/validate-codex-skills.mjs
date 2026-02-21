#!/usr/bin/env node
/**
 * Validate that all Codex skills in .codex/skills/<skill>/SKILL.md have YAML frontmatter
 * with at least: name, description.
 *
 * This is intentionally a tiny validator (no YAML deps) to keep the cockpit portable.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const CANONICAL_KEY_ORDER = [
  'name',
  'description',
  'version',
  'tags',
  'disable-model-invocation',
  'user-invocable',
  'allowed-tools',
  'argument-hint',
];
const LEARNED_BEGIN = '<!-- SKILLOPS:LEARNED:BEGIN -->';
const LEARNED_END = '<!-- SKILLOPS:LEARNED:END -->';

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
  const keyOrder = [];
  const keySet = new Set();
  for (const line of fmLines) {
    const m = /^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    if (!keySet.has(key)) {
      keyOrder.push(key);
      keySet.add(key);
    }
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return { fm, bodyStart: end + 1, keyOrder };
}

function hasCanonicalKeyOrder(keys) {
  let lastKnownIndex = -1;
  for (const key of keys) {
    const idx = CANONICAL_KEY_ORDER.indexOf(key);
    if (idx < 0) continue;
    if (idx < lastKnownIndex) return false;
    lastKnownIndex = idx;
  }
  return true;
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

    const { fm, keyOrder } = parseFrontmatter(raw);
    if (!fm) {
      errors.push(`${name}: missing YAML frontmatter (--- ... ---)`);
      continue;
    }
    if (!fm.name) errors.push(`${name}: frontmatter missing "name"`);
    if (!fm.description) errors.push(`${name}: frontmatter missing "description"`);

    if (fm.name && fm.name !== name) {
      warnings.push(`${name}: frontmatter name "${fm.name}" does not match folder name`);
    }
    if (!hasCanonicalKeyOrder(Array.isArray(keyOrder) ? keyOrder : [])) {
      errors.push(`${name}: frontmatter key order is non-canonical`);
    }

    const hasBegin = raw.includes(LEARNED_BEGIN);
    const hasEnd = raw.includes(LEARNED_END);
    if (hasBegin !== hasEnd) {
      errors.push(`${name}: learned markers must include both BEGIN and END`);
    }
    if (hasBegin && hasEnd && raw.indexOf(LEARNED_END) < raw.indexOf(LEARNED_BEGIN)) {
      errors.push(`${name}: learned markers are out of order`);
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

  await writeStdout('OK: all skills have valid frontmatter and canonical ordering\n');
}

main().catch((err) => {
  process.exitCode = 1;
  // Best-effort: flush error text so tests/CI capture it reliably (stdio may be a pipe).
  writeStderr(`ERROR: ${(err && err.stack) || String(err)}\n`).catch(() => {});
});
