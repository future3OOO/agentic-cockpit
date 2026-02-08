#!/usr/bin/env node
/**
 * Repo-local continuity ledger utility for Agentic Cockpit.
 *
 * Supports init/check/trim plus --help so agents can avoid trial-and-error
 * command calls that waste exec cycles.
 */

import { writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

function fail(message) {
  throw new CliError(message, 1);
}

function writeStdout(text) {
  writeSync(process.stdout.fd, text);
}

function writeStderrLine(text) {
  writeSync(process.stderr.fd, `${text}\n`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const ledgerPath = path.join(repoRoot, '.codex', 'CONTINUITY.md');
const usage = `Usage:
  node scripts/continuity-ledger.mjs [command] [--max-lines N]

Commands:
  check   Validate .codex/CONTINUITY.md headings + line budget (default)
  init    Create .codex/CONTINUITY.md if missing
  ensure  Alias of init
  trim    Clamp sections to stay under the line budget

Options:
  --max-lines N   Override max line budget (default: 150)
  -h, --help      Show this help text
`;

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
  const args = { command: null, maxLines: 150, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    if (token === '--max-lines') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        fail('continuity-ledger: --max-lines must be a positive integer');
      }
      args.maxLines = value;
      i += 1;
      continue;
    }
    if (token.startsWith('-')) {
      fail(`continuity-ledger: unknown arg: ${token} (run: node scripts/continuity-ledger.mjs --help)`);
    }
    if (args.command === null) {
      args.command = token;
      continue;
    }
    fail(`continuity-ledger: unexpected extra arg: ${token} (run: node scripts/continuity-ledger.mjs --help)`);
  }
  if (args.command === null) args.command = 'check';
  return args;
}

function printUsage() {
  writeStdout(usage);
}

function templateLedger() {
  const byHeading = new Map(HEADINGS.map((h) => [h, []]));
  byHeading.set(HEADINGS[0], ['- UNCONFIRMED']);
  byHeading.set(HEADINGS[1], ['- UNCONFIRMED']);
  byHeading.set(HEADINGS[2], ['- UNCONFIRMED']);
  byHeading.set(HEADINGS[3], ['- UNCONFIRMED']);
  byHeading.set(HEADINGS[4], ['- (none)']);
  byHeading.set(HEADINGS[5], ['- UNCONFIRMED']);
  byHeading.set(HEADINGS[6], ['- UNCONFIRMED']);
  byHeading.set(HEADINGS[7], ['- UNCONFIRMED']);
  byHeading.set(HEADINGS[8], ['- (none)']);

  const out = [];
  for (const heading of HEADINGS) {
    out.push(heading);
    for (const line of byHeading.get(heading) || []) out.push(line);
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

async function ensureLedgerExists() {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  try {
    await fs.stat(ledgerPath);
    return;
  } catch {
    await fs.writeFile(ledgerPath, templateLedger(), 'utf8');
  }
}

function parseSections(contents) {
  const lines = contents.replace(/\r\n/g, '\n').split('\n');
  const sections = new Map();
  let currentHeading = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (HEADINGS.includes(trimmed)) {
      currentHeading = trimmed;
      if (!sections.has(currentHeading)) sections.set(currentHeading, []);
      continue;
    }
    if (currentHeading) sections.get(currentHeading).push(line);
  }
  return sections;
}

async function checkLedger({ maxLines }) {
  let contents;
  try {
    contents = await fs.readFile(ledgerPath, 'utf8');
  } catch {
    fail(
      `continuity-ledger: missing ${path.relative(repoRoot, ledgerPath)} (run: node scripts/continuity-ledger.mjs init)`,
    );
  }

  const normalized = contents.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > maxLines) {
    fail(`continuity-ledger: too long (${lines.length} lines > ${maxLines}); run: node scripts/continuity-ledger.mjs trim`);
  }

  const missing = HEADINGS.filter((h) => !normalized.includes(`\n${h}\n`) && !normalized.startsWith(`${h}\n`));
  if (missing.length) fail(`continuity-ledger: missing headings: ${missing.join(', ')}`);
}

function clampSectionLines(sectionLines, maxContentLines, { emptyPlaceholder }) {
  const normalized = sectionLines.map((l) => l.replace(/\s+$/g, '')).filter((l) => l.trim() !== '');
  const trimmed = normalized.slice(0, maxContentLines);
  if (trimmed.length === 0) return [emptyPlaceholder];
  return trimmed;
}

async function trimLedger({ maxLines }) {
  await ensureLedgerExists();
  const contents = await fs.readFile(ledgerPath, 'utf8');
  const sections = parseSections(contents);
  const caps = new Map([
    [HEADINGS[0], { max: 6, empty: '- UNCONFIRMED' }],
    [HEADINGS[1], { max: 12, empty: '- UNCONFIRMED' }],
    [HEADINGS[2], { max: 12, empty: '- UNCONFIRMED' }],
    [HEADINGS[3], { max: 8, empty: '- UNCONFIRMED' }],
    [HEADINGS[4], { max: 30, empty: '- (none)' }],
    [HEADINGS[5], { max: 12, empty: '- UNCONFIRMED' }],
    [HEADINGS[6], { max: 12, empty: '- UNCONFIRMED' }],
    [HEADINGS[7], { max: 12, empty: '- UNCONFIRMED' }],
    [HEADINGS[8], { max: 20, empty: '- (none)' }],
  ]);

  const out = [];
  for (const heading of HEADINGS) {
    const cap = caps.get(heading);
    const contentLines = sections.get(heading) || [];
    out.push(heading);
    const clamped = clampSectionLines(contentLines, cap.max, { emptyPlaceholder: cap.empty });
    for (const line of clamped) out.push(line);
    out.push('');
  }

  let final = out.join('\n');
  if (!final.endsWith('\n')) final += '\n';
  const finalLines = final.split('\n');
  if (finalLines.length > maxLines) {
    fail(`continuity-ledger: trim produced ${finalLines.length} lines (> ${maxLines}); reduce caps in script`);
  }

  await fs.writeFile(ledgerPath, final, 'utf8');
}

async function main() {
  const { command, maxLines, help } = parseArgs(process.argv);
  if (help) {
    printUsage();
    return;
  }

  if (command === 'init' || command === 'ensure') {
    await ensureLedgerExists();
  } else if (command === 'check') {
    await checkLedger({ maxLines });
  } else if (command === 'trim') {
    await trimLedger({ maxLines });
  } else {
    fail(
      `continuity-ledger: unknown command: ${command} (expected: init|ensure|check|trim; run: node scripts/continuity-ledger.mjs --help)`,
    );
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof CliError) {
    writeStderrLine(error.message);
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
