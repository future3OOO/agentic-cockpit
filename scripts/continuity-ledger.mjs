#!/usr/bin/env node
/**
 * Repo-local continuity ledger guard for Agentic Cockpit.
 *
 * This is intentionally tiny and dependency-free.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const ledgerPath = path.join(repoRoot, '.codex', 'CONTINUITY.md');

const HEADINGS = [
  'Goal (incl. success criteria):',
  'Constraints/Assumptions:',
  'Key decisions:',
  'State:',
  'Done:',
  'Now:',
  'Next:',
  'Open questions (UNCONFIRMED if needed):',
  'Working set (files/ids/commands):',
];

function parseArgs(argv) {
  const args = { command: argv[2] || 'check', maxLines: 180 };
  for (let i = 3; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--max-lines') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) fail('continuity-ledger: --max-lines must be a positive number');
      args.maxLines = Math.floor(value);
      i += 1;
      continue;
    }
    fail(`continuity-ledger: unknown arg: ${token}`);
  }
  return args;
}

function templateLedger() {
  const out = [];
  for (const h of HEADINGS) {
    out.push(h);
    out.push('- UNCONFIRMED');
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

async function ensureLedgerExists() {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  try {
    await fs.stat(ledgerPath);
  } catch {
    await fs.writeFile(ledgerPath, templateLedger(), 'utf8');
  }
}

async function checkLedger({ maxLines }) {
  let contents;
  try {
    contents = await fs.readFile(ledgerPath, 'utf8');
  } catch {
    fail(`continuity-ledger: missing ${path.relative(repoRoot, ledgerPath)} (run: node scripts/continuity-ledger.mjs init)`);
  }

  const lines = contents.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > maxLines) {
    fail(`continuity-ledger: too long (${lines.length} lines > ${maxLines}); trim the file`);
  }

  const missing = HEADINGS.filter((h) => !contents.includes(`\n${h}\n`) && !contents.startsWith(`${h}\n`));
  if (missing.length) fail(`continuity-ledger: missing headings: ${missing.join(', ')}`);
}

const { command, maxLines } = parseArgs(process.argv);

if (command === 'init' || command === 'ensure') {
  await ensureLedgerExists();
} else if (command === 'check') {
  await checkLedger({ maxLines });
} else {
  fail(`continuity-ledger: unknown command: ${command} (expected: init|check)`);
}

