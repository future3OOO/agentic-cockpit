#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { CANONICAL_KEY_ORDER } from './lib/skill-frontmatter.mjs';

function usage() {
  return [
    'skills-format',
    '',
    'Usage:',
    '  node scripts/skills-format.mjs --check',
    '  node scripts/skills-format.mjs --write',
    '',
    'Validates (and optionally rewrites) SKILL.md YAML frontmatter to canonical key order.',
  ].join('\n');
}

function parseFrontmatter(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  return {
    lines,
    start: 0,
    end,
    frontmatterLines: lines.slice(1, end),
    bodyLines: lines.slice(end + 1),
  };
}

function parseFrontmatterBlocks(frontmatterLines) {
  /** @type {{key: string, lines: string[]}[]} */
  const blocks = [];
  let i = 0;
  while (i < frontmatterLines.length) {
    const line = frontmatterLines[i];
    const m = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const blockLines = [line];
    i += 1;
    while (i < frontmatterLines.length) {
      const next = frontmatterLines[i];
      if (/^[A-Za-z0-9_-]+\s*:/.test(next)) break;
      blockLines.push(next);
      i += 1;
    }
    blocks.push({ key, lines: blockLines });
  }
  return blocks;
}

function canonicalizeFrontmatter(frontmatterLines) {
  const blocks = parseFrontmatterBlocks(frontmatterLines);
  const byKey = new Map();
  const unknownKeys = [];
  for (const block of blocks) {
    if (!byKey.has(block.key)) byKey.set(block.key, block);
    if (!CANONICAL_KEY_ORDER.includes(block.key)) unknownKeys.push(block.key);
  }

  const ordered = [];
  for (const key of CANONICAL_KEY_ORDER) {
    const block = byKey.get(key);
    if (block) ordered.push(...block.lines);
  }
  const seenUnknown = new Set();
  for (const key of unknownKeys) {
    if (seenUnknown.has(key)) continue;
    seenUnknown.add(key);
    const block = byKey.get(key);
    if (block) ordered.push(...block.lines);
  }
  return ordered;
}

async function listSkillFiles(skillsRoot) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const p = path.join(skillsRoot, entry.name, 'SKILL.md');
    try {
      const st = await fs.stat(p);
      if (st.isFile()) out.push(p);
    } catch {
      // ignore
    }
  }
  out.sort();
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const write = argv.includes('--write');
  if (!check && !write) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (check && write) {
    throw new Error('choose one mode: --check or --write');
  }

  const repoRoot = process.cwd();
  const skillsRoot = path.join(repoRoot, '.codex', 'skills');
  const files = await listSkillFiles(skillsRoot);
  if (!files.length) {
    process.stdout.write('No SKILL.md files found.\n');
    return;
  }

  const issues = [];
  let rewrites = 0;

  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      issues.push(`${path.relative(repoRoot, file)}: missing frontmatter`);
      continue;
    }

    const current = parsed.frontmatterLines;
    const canonical = canonicalizeFrontmatter(current);
    const currentJoined = current.join('\n').trim();
    const canonicalJoined = canonical.join('\n').trim();
    if (currentJoined === canonicalJoined) continue;

    if (check) {
      issues.push(`${path.relative(repoRoot, file)}: non-canonical frontmatter key order`);
      continue;
    }

    const next = [
      '---',
      ...canonical,
      '---',
      ...parsed.bodyLines,
    ].join('\n');
    await fs.writeFile(file, next, 'utf8');
    rewrites += 1;
  }

  if (issues.length) {
    process.stderr.write(`FAIL:\n- ${issues.join('\n- ')}\n`);
    process.exitCode = 2;
    return;
  }
  if (check) {
    process.stdout.write(`OK: ${files.length} skill files have canonical frontmatter order.\n`);
  } else {
    process.stdout.write(`OK: rewrote ${rewrites} skill file(s) to canonical frontmatter order.\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${(err && err.stack) || String(err)}\n`);
  process.exitCode = 1;
});
