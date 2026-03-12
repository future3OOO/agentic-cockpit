import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function trim(value) {
  return String(value ?? '').trim();
}

function normalizeRepoPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidBranchName(name) {
  // Conservative validation: allow common git branch characters and slashes.
  // This avoids accidentally passing whitespace or shell-ish content into git.
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(name);
}

function normalizeBranchName(name) {
  const raw = trim(name);
  if (!raw) return null;
  const withoutPrefix = raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw;
  if (!isValidBranchName(withoutPrefix)) return null;
  return withoutPrefix;
}

function isValidSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim());
}

function normalizeSha(value) {
  const raw = trim(value);
  if (!raw) return null;
  if (!isValidSha(raw)) return null;
  return raw;
}

function run(cmd, args, { cwd }) {
  const res = childProcess.spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: res.status === 0,
    status: res.status ?? 1,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
  };
}

function git(args, { cwd }) {
  return run('git', args, { cwd });
}

function gitText(args, { cwd }) {
  const res = git(args, { cwd });
  if (!res.ok) return null;
  const s = res.stdout.trim();
  return s ? s : null;
}

function gitOk(args, { cwd }) {
  const res = git(args, { cwd });
  return res.ok;
}

function truncate(value, maxLen = 500) {
  const s = String(value ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trimEnd() + '…';
}

function isDisposableRuntimeArtifactPath(relPath) {
  const p = normalizeRepoPath(relPath).toLowerCase().replace(/\/+$/, '');
  if (!p) return false;
  return (
    p === '.codex/quality' ||
    p.startsWith('.codex/quality/') ||
    p === '.codex/reviews' ||
    p.startsWith('.codex/reviews/') ||
    p === '.codex-tmp' ||
    p.startsWith('.codex-tmp/') ||
    p === 'artifacts' ||
    p.startsWith('artifacts/')
  );
}

function isSkillOpsLogPath(relPath) {
  const p = normalizeRepoPath(relPath).toLowerCase().replace(/\/+$/, '');
  if (!p) return false;
  if (!p.startsWith('.codex/skill-ops/logs/')) return false;
  if (!p.endsWith('.md')) return false;
  return path.basename(p) !== 'readme.md';
}

function readFrontmatterParts(raw) {
  const text = String(raw ?? '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) return null;
  return {
    frontmatter: match[1] || '',
    body: match[2] || '',
  };
}

function splitNonEmptyLines(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trimEnd())
    .filter(Boolean);
}

function listDirEntries(absPath) {
  return fs.readdirSync(absPath, { withFileTypes: true });
}

function everyDisposableDirEntry(absPath, visitEntry) {
  const entries = listDirEntries(absPath);
  if (!entries.length) return true;
  for (const entry of entries) {
    if (!visitEntry(entry)) return false;
  }
  return true;
}

function hasNonEmptySkillUpdates(frontmatter) {
  const lines = String(frontmatter || '').split(/\r?\n/);
  let inSection = false;
  let sectionIndent = 0;
  let currentSkillIndent = null;
  let sawSection = false;

  for (const line of lines) {
    const indent = (line.match(/^ */) || [''])[0].length;
    const trimmed = line.trim();

    if (!inSection) {
      if (/^skill_updates:\s*\{\s*\}\s*$/.test(trimmed)) {
        return false;
      }
      if (trimmed === 'skill_updates:') {
        inSection = true;
        sawSection = true;
        sectionIndent = indent;
        currentSkillIndent = null;
      }
      continue;
    }

    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (indent <= sectionIndent) break;

    const isTopLevelSkillEntry = indent === sectionIndent + 2;

    if (isTopLevelSkillEntry && /^[^:#][^:]*:\s*\[\s*\]\s*$/.test(trimmed)) {
      currentSkillIndent = indent;
      continue;
    }
    const inlineMatch = isTopLevelSkillEntry ? trimmed.match(/^[^:#][^:]*:\s*\[(.*)\]\s*$/) : null;
    if (inlineMatch) {
      const inner = String(inlineMatch[1] || '').trim();
      if (inner) return true;
      currentSkillIndent = indent;
      continue;
    }
    if (isTopLevelSkillEntry && /^[^:#][^:]*:\s*$/.test(trimmed)) {
      currentSkillIndent = indent;
      continue;
    }
    if (currentSkillIndent != null && indent > currentSkillIndent && /^-\s+/.test(trimmed)) {
      return true;
    }
    return true;
  }

  return sawSection ? false : true;
}

const DEFAULT_SKILLOPS_BODY_LINES = new Set([
  '# Summary',
  '- What changed:',
  '- Why:',
  '# Verification',
  '- Commands run:',
  '- Results:',
  '# Learnings',
  '- Add concise reusable rules into `skill_updates` in frontmatter before running distill.',
]);

function hasMeaningfulSkillOpsBody(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  for (const line of lines) {
    if (DEFAULT_SKILLOPS_BODY_LINES.has(line)) continue;
    return true;
  }
  return false;
}

function isDisposableEmptySkillOpsLog(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    const parsed = readFrontmatterParts(raw);
    if (!parsed) return false;
    if (hasNonEmptySkillUpdates(parsed.frontmatter)) return false;
    return !hasMeaningfulSkillOpsBody(parsed.body);
  } catch {
    return false;
  }
}

function isDisposableEmptySkillOpsEntry(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (st.isFile()) return isDisposableEmptySkillOpsLog(absPath);
    if (!st.isDirectory()) return false;
    return everyDisposableDirEntry(absPath, (entry) => {
      const childPath = path.join(absPath, entry.name);
      if (entry.isDirectory()) {
        return isDisposableEmptySkillOpsEntry(childPath);
      }
      if (!entry.isFile()) return false;
      if (entry.name.toLowerCase() === 'readme.md') return true;
      return isDisposableEmptySkillOpsLog(childPath);
    });
  } catch {
    return false;
  }
}

function isDisposableRuntimeEntry(absPath, relPath) {
  const p = normalizeRepoPath(relPath).toLowerCase().replace(/\/+$/, '');
  if (!p) return false;
  try {
    const st = fs.statSync(absPath);
    if (st.isFile()) {
      if (isDisposableRuntimeArtifactPath(p)) return true;
      if (isSkillOpsLogPath(p)) return isDisposableEmptySkillOpsLog(absPath);
      return false;
    }
    if (!st.isDirectory()) return false;
    if (isDisposableRuntimeArtifactPath(p)) return true;
    if (p.startsWith('.codex/skill-ops')) return isDisposableEmptySkillOpsEntry(absPath);
    if (p !== '.codex') return false;

    return everyDisposableDirEntry(absPath, (entry) => {
      const childAbs = path.join(absPath, entry.name);
      const childRel = normalizeRepoPath(path.posix.join(p, entry.name));
      return isDisposableRuntimeEntry(childAbs, childRel);
    });
  } catch {
    return false;
  }
}

function isIgnorableRuntimeArtifactStatusLine(line, { cwd }) {
  const raw = String(line || '').trim();
  if (!raw.startsWith('?? ')) return false;
  const relPath = normalizeRepoPath(raw.slice(3));
  if (!relPath) return false;
  return isDisposableRuntimeEntry(path.join(cwd, relPath), relPath);
}

export function summarizeBlockingGitStatusPorcelain({ cwd, statusPorcelain }) {
  const lines = splitNonEmptyLines(statusPorcelain);
  return lines
    .filter((line) => !isIgnorableRuntimeArtifactStatusLine(line, { cwd }))
    .join('\n')
    .trim();
}

function cleanupIgnorableRuntimeArtifacts({ cwd, statusPorcelain }) {
  const lines = splitNonEmptyLines(statusPorcelain);
  const removedPaths = [];
  for (const line of lines) {
    if (!isIgnorableRuntimeArtifactStatusLine(line, { cwd })) continue;
    const relPath = normalizeRepoPath(line.slice(3));
    if (!relPath) continue;
    try {
      fs.rmSync(path.join(cwd, relPath), { recursive: true, force: true });
      removedPaths.push(relPath);
    } catch {
      // best effort; if cleanup fails, normal preflight will still block later
    }
  }
  return { removedPaths };
}

export class TaskGitPreflightBlockedError extends Error {
  constructor(message, { cwd, taskKind, contract, details } = {}) {
    super(message);
    this.name = 'TaskGitPreflightBlockedError';
    this.cwd = cwd || null;
    this.taskKind = taskKind || null;
    this.contract = contract || null;
    this.details = details || null;
  }
}

export function readTaskGitContract(meta) {
  const refs = isObject(meta?.references) ? meta.references : null;
  const gitRefs = isObject(refs?.git) ? refs.git : null;
  if (!gitRefs) return null;

  const baseBranchRaw = trim(gitRefs.baseBranch);
  const baseBranch = baseBranchRaw ? baseBranchRaw : null;
  const baseSha = normalizeSha(gitRefs.baseSha);
  const workBranch = normalizeBranchName(gitRefs.workBranch);
  const integrationBranchRaw = trim(gitRefs.integrationBranch);
  const integrationBranch = integrationBranchRaw ? integrationBranchRaw : null;
  const expectedDeploy = isObject(gitRefs.expectedDeploy) ? gitRefs.expectedDeploy : null;

  return {
    baseBranch,
    baseSha,
    workBranch,
    integrationBranch,
    expectedDeploy,
  };
}

export function getGitSnapshot({ cwd }) {
  const isRepo = gitOk(['rev-parse', '--is-inside-work-tree'], { cwd });
  if (!isRepo) return null;
  const branch = gitText(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const headSha = gitText(['rev-parse', 'HEAD'], { cwd });
  const statusPorcelain = gitText(['status', '--porcelain'], { cwd }) || '';
  return {
    branch: branch || null,
    headSha: headSha || null,
    isDirty: Boolean(statusPorcelain.trim()),
    statusPorcelain,
  };
}

function ensureBaseShaPresent({ cwd, baseSha, baseBranch, allowFetch }) {
  if (!baseSha) return { ok: false, fetched: false, note: 'missing baseSha' };

  const exists = gitOk(['cat-file', '-e', `${baseSha}^{commit}`], { cwd });
  if (exists) return { ok: true, fetched: false, note: null };
  if (!allowFetch) return { ok: false, fetched: false, note: 'baseSha not found locally' };

  // Best-effort fetch: fetch all remotes (works even when baseBranch is a local-only label like slice/*).
  const fetchedOk = gitOk(['fetch', '--all', '--prune'], { cwd });

  const existsAfter = gitOk(['cat-file', '-e', `${baseSha}^{commit}`], { cwd });
  if (existsAfter) return { ok: true, fetched: true, note: null };

  return {
    ok: false,
    fetched: fetchedOk,
    note: 'baseSha not found (even after fetch)',
  };
}

function ensureAncestor({ cwd, baseSha }) {
  if (!baseSha) return true;
  return gitOk(['merge-base', '--is-ancestor', baseSha, 'HEAD'], { cwd });
}

export function ensureTaskGitContract({
  cwd,
  taskKind,
  contract,
  enforce = false,
  allowFetch = true,
  autoCleanDirtyExecute = false,
  log = null,
} = {}) {
  const contractObj = contract || null;

  if (!contractObj) {
    if (enforce && taskKind === 'EXECUTE') {
      throw new TaskGitPreflightBlockedError('Missing references.git for EXECUTE task', {
        cwd,
        taskKind,
        contract: null,
        details: { required: ['baseSha', 'workBranch'] },
      });
    }
    return { applied: false, snapshot: getGitSnapshot({ cwd }), contract: null };
  }

  const { baseBranch, baseSha, workBranch } = contractObj;
  const normalizedTaskKind = String(taskKind || '').trim().toUpperCase();
  const requiresHardSync = normalizedTaskKind === 'EXECUTE' && Boolean(workBranch) && Boolean(baseSha);

  if (enforce && taskKind === 'EXECUTE') {
    if (!baseSha || !workBranch) {
      throw new TaskGitPreflightBlockedError('EXECUTE task missing required references.git fields', {
        cwd,
        taskKind,
        contract: contractObj,
        details: { missing: [!baseSha ? 'baseSha' : null, !workBranch ? 'workBranch' : null].filter(Boolean) },
      });
    }
  }
  if (normalizedTaskKind === 'EXECUTE' && workBranch && !baseSha) {
    throw new TaskGitPreflightBlockedError('EXECUTE task requires references.git.baseSha for deterministic branch sync', {
      cwd,
      taskKind,
      contract: contractObj,
      details: { missing: ['baseSha'] },
    });
  }

  let snap0 = getGitSnapshot({ cwd });
  if (!snap0) {
    throw new TaskGitPreflightBlockedError('Task workdir is not a git repo', {
      cwd,
      taskKind,
      contract: contractObj,
    });
  }

  let autoCleaned = false;
  /** @type {null|{statusPorcelain: string, diffWorking: string, diffStaged: string}} */
  let autoCleanDetails = null;

  if (!workBranch) {
    // Nothing to check out; still validate ancestor if baseSha was provided.
    if (baseSha && !ensureAncestor({ cwd, baseSha })) {
      throw new TaskGitPreflightBlockedError('Current HEAD does not include baseSha (git drift)', {
        cwd,
        taskKind,
        contract: contractObj,
        details: { branch: snap0.branch, headSha: snap0.headSha, baseSha },
      });
    }
    return { applied: false, snapshot: snap0, contract: contractObj };
  }

  // Deterministic EXECUTE preflight requires clean tree so branch hard-sync can run safely.
  if (snap0.isDirty) {
    const disposableCleanup = cleanupIgnorableRuntimeArtifacts({
      cwd,
      statusPorcelain: snap0.statusPorcelain,
    });
    if (disposableCleanup.removedPaths.length) {
      snap0 = getGitSnapshot({ cwd }) || snap0;
      if (log) {
        log(
          `[worker] git preflight auto-cleaned runtime artifacts: ${disposableCleanup.removedPaths.join(', ')}\n`,
        );
      }
    }
  }

  if (snap0.isDirty) {
    if (autoCleanDirtyExecute && requiresHardSync) {
      const statusBefore = String(snap0.statusPorcelain || '');
      const diffWorking = gitText(['diff', '--no-ext-diff', '--binary'], { cwd }) || '';
      const diffStaged = gitText(['diff', '--cached', '--no-ext-diff', '--binary'], { cwd }) || '';
      const reset = git(['reset', '--hard'], { cwd });
      if (!reset.ok) {
        throw new TaskGitPreflightBlockedError('Failed to auto-clean dirty worktree (git reset --hard)', {
          cwd,
          taskKind,
          contract: contractObj,
          details: {
            currentBranch: snap0.branch,
            statusPorcelain: truncate(snap0.statusPorcelain, 1200),
            stderr: truncate(reset.stderr, 1200),
          },
        });
      }
      const clean = git(['clean', '-fd'], { cwd });
      if (!clean.ok) {
        throw new TaskGitPreflightBlockedError('Failed to auto-clean dirty worktree (git clean -fd)', {
          cwd,
          taskKind,
          contract: contractObj,
          details: {
            currentBranch: snap0.branch,
            statusPorcelain: truncate(snap0.statusPorcelain, 1200),
            stderr: truncate(clean.stderr, 1200),
          },
        });
      }
      snap0 = getGitSnapshot({ cwd }) || snap0;
      if (snap0.isDirty) {
        throw new TaskGitPreflightBlockedError('Worktree remains dirty after auto-clean', {
          cwd,
          taskKind,
          contract: contractObj,
          details: { currentBranch: snap0.branch, statusPorcelain: truncate(snap0.statusPorcelain, 1200) },
        });
      }
      autoCleaned = true;
      autoCleanDetails = {
        statusPorcelain: truncate(statusBefore, 16_000),
        diffWorking: truncate(diffWorking, 200_000),
        diffStaged: truncate(diffStaged, 200_000),
      };
    } else {
      throw new TaskGitPreflightBlockedError(
        'Worktree has uncommitted changes; refusing deterministic branch sync for task',
        {
          cwd,
          taskKind,
          contract: contractObj,
          details: { currentBranch: snap0.branch, statusPorcelain: truncate(snap0.statusPorcelain, 1200) },
        },
      );
    }
  }

  const branchExists = gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${workBranch}`], { cwd });
  let created = false;
  let fetched = false;
  let hardSynced = false;

  if (baseSha && (requiresHardSync || !branchExists)) {
    const base = ensureBaseShaPresent({ cwd, baseSha, baseBranch, allowFetch });
    fetched = Boolean(base.fetched);
    if (!base.ok) {
      throw new TaskGitPreflightBlockedError(`baseSha ${baseSha} is not available locally`, {
        cwd,
        taskKind,
        contract: contractObj,
        details: { baseBranch, baseSha, note: base.note },
      });
    }
  }

  if (branchExists) {
    const checkout = git(['checkout', workBranch], { cwd });
    if (!checkout.ok) {
      throw new TaskGitPreflightBlockedError(`Failed to checkout workBranch ${workBranch}`, {
        cwd,
        taskKind,
        contract: contractObj,
        details: { stderr: truncate(checkout.stderr, 1200) },
      });
    }
  } else {
    if (!baseSha) {
      throw new TaskGitPreflightBlockedError(`workBranch ${workBranch} does not exist and baseSha is missing`, {
        cwd,
        taskKind,
        contract: contractObj,
      });
    }
    const checkout = git(['checkout', '-b', workBranch, baseSha], { cwd });
    if (!checkout.ok) {
      throw new TaskGitPreflightBlockedError(`Failed to create workBranch ${workBranch} at ${baseSha}`, {
        cwd,
        taskKind,
        contract: contractObj,
        details: { stderr: truncate(checkout.stderr, 1200) },
      });
    }
    created = true;
  }

  if (requiresHardSync && baseSha) {
    const reset = git(['reset', '--hard', baseSha], { cwd });
    if (!reset.ok) {
      throw new TaskGitPreflightBlockedError(`Failed to hard-sync workBranch ${workBranch} to ${baseSha}`, {
        cwd,
        taskKind,
        contract: contractObj,
        details: { stderr: truncate(reset.stderr, 1200) },
      });
    }
    hardSynced = true;
  }

  const snap1 = getGitSnapshot({ cwd }) || snap0;
  if (baseSha) {
    if (requiresHardSync) {
      if (String(snap1.headSha || '').toLowerCase() !== String(baseSha).toLowerCase()) {
        throw new TaskGitPreflightBlockedError('Checked out branch is not pinned to required baseSha after hard sync', {
          cwd,
          taskKind,
          contract: contractObj,
          details: { branch: snap1.branch, headSha: snap1.headSha, baseSha },
        });
      }
    } else if (!ensureAncestor({ cwd, baseSha })) {
      throw new TaskGitPreflightBlockedError('Checked out branch does not include baseSha (git drift)', {
        cwd,
        taskKind,
        contract: contractObj,
        details: { branch: snap1.branch, headSha: snap1.headSha, baseSha },
      });
    }
  }

  if (log) {
    const baseMsg = baseSha ? ` baseSha=${baseSha}` : '';
    const createdMsg = created ? ' created' : '';
    const fetchedMsg = fetched ? ' fetched' : '';
    const syncMsg = hardSynced ? ' hardSynced' : '';
    log(`[worker] git preflight ok: workBranch=${workBranch}${baseMsg}${createdMsg}${fetchedMsg}${syncMsg}\n`);
  }

  return {
    applied: true,
    created,
    fetched,
    hardSynced,
    autoCleaned,
    autoCleanDetails,
    snapshot: snap1,
    contract: contractObj,
  };
}
