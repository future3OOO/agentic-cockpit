import childProcess from 'node:child_process';

function trim(value) {
  return String(value ?? '').trim();
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

  const snap0 = getGitSnapshot({ cwd });
  if (!snap0) {
    throw new TaskGitPreflightBlockedError('Task workdir is not a git repo', {
      cwd,
      taskKind,
      contract: contractObj,
    });
  }

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

  // Already on requested branch: allow dirty tree (in-progress work).
  if (snap0.branch === workBranch) {
    if (baseSha && !ensureAncestor({ cwd, baseSha })) {
      throw new TaskGitPreflightBlockedError('workBranch HEAD does not include baseSha (git drift)', {
        cwd,
        taskKind,
        contract: contractObj,
        details: { branch: snap0.branch, headSha: snap0.headSha, baseSha },
      });
    }
    return { applied: true, created: false, fetched: false, snapshot: snap0, contract: contractObj };
  }

  // Need to switch/create branch.
  if (snap0.isDirty) {
    throw new TaskGitPreflightBlockedError(
      'Worktree has uncommitted changes; refusing to switch branches for task',
      {
        cwd,
        taskKind,
        contract: contractObj,
        details: { currentBranch: snap0.branch, statusPorcelain: truncate(snap0.statusPorcelain, 1200) },
      },
    );
  }

  const branchExists = gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${workBranch}`], { cwd });
  let created = false;
  let fetched = false;

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

  const snap1 = getGitSnapshot({ cwd }) || snap0;
  if (baseSha && !ensureAncestor({ cwd, baseSha })) {
    throw new TaskGitPreflightBlockedError('Checked out branch does not include baseSha (git drift)', {
      cwd,
      taskKind,
      contract: contractObj,
      details: { branch: snap1.branch, headSha: snap1.headSha, baseSha },
    });
  }

  if (log) {
    const baseMsg = baseSha ? ` baseSha=${baseSha}` : '';
    const createdMsg = created ? ' created' : '';
    const fetchedMsg = fetched ? ' fetched' : '';
    log(`[worker] git preflight ok: workBranch=${workBranch}${baseMsg}${createdMsg}${fetchedMsg}\n`);
  }

  return { applied: true, created, fetched, snapshot: snap1, contract: contractObj };
}
