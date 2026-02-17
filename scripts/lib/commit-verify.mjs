import childProcess from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(childProcess.execFile);

/** Return a de-duplicated list while preserving first-seen order. */
function uniq(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

/** Parse a comma-separated env value into trimmed tokens. */
function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Convert an upstream ref like "origin/main" into "origin". */
function parseUpstreamRemoteName(upstreamRef) {
  const raw = String(upstreamRef || '').trim();
  if (!raw) return '';
  const slash = raw.indexOf('/');
  if (slash <= 0) return '';
  return raw.slice(0, slash).trim();
}

/** Run a command and return trimmed stdout or throw on command failure. */
async function readStdout(cmd, args, { cwd, env }) {
  const res = await execFile(cmd, args, { cwd, env, maxBuffer: 4 * 1024 * 1024 });
  return String(res.stdout || '').trim();
}

/** Read `git remote` names for the working tree. */
async function listGitRemotes({ cwd, env }) {
  const out = await readStdout('git', ['remote'], { cwd, env });
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Best-effort read of the upstream remote name for prioritizing verification order. */
async function readUpstreamRemote({ cwd, env }) {
  try {
    const upstream = await readStdout('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
      cwd,
      env,
    });
    return parseUpstreamRemoteName(upstream);
  } catch {
    // Missing upstream should not fail verification setup.
    return '';
  }
}

/** Collapse exec errors to a short stderr/stdout/message summary. */
function summarizeExecError(err) {
  const stderr = String(err?.stderr || '').trim();
  if (stderr) return stderr;
  const stdout = String(err?.stdout || '').trim();
  if (stdout) return stdout;
  return (err && err.message) || String(err);
}

/** Fetch one remote so `branch -r --contains` reflects latest remote state. */
async function fetchRemote({ cwd, env, remote }) {
  try {
    await execFile('git', ['fetch', remote, '--prune'], { cwd, env, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: summarizeExecError(err) };
  }
}

/** List remote refs under `<remote>/...` that contain the commit. */
async function listRemoteRefsContaining({ cwd, env, commitSha, remote }) {
  try {
    const res = await execFile('git', ['branch', '-r', '--contains', commitSha], {
      cwd,
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(res.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line.startsWith(`${remote}/`));
  } catch (err) {
    const raw = String(err?.stdout || '');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line.startsWith(`${remote}/`));
  }
}

/**
 * Verify whether a commit is reachable on configured remotes without using `git fetch --all`.
 * The default allowlist is `origin,github` so worker checks avoid unrelated remotes
 * (for example deployment remotes such as `hetzner`).
 */
export async function verifyCommitShaOnAllowedRemotes({ cwd, commitSha, env = process.env }) {
  const sha = String(commitSha || '').trim();
  if (!sha) {
    return {
      checked: false,
      reachable: true,
      reason: 'no_commit_sha',
      commitSha: '',
      attemptedRemotes: [],
      remoteRefs: [],
      errors: [],
    };
  }

  /** @type {string[]} */
  let availableRemotes = [];
  try {
    availableRemotes = await listGitRemotes({ cwd, env });
  } catch (err) {
    return {
      checked: false,
      reachable: false,
      reason: 'git_remote_error',
      commitSha: sha,
      attemptedRemotes: [],
      remoteRefs: [],
      errors: [
        {
          phase: 'list_remotes',
          error: summarizeExecError(err),
        },
      ],
    };
  }
  const allowedConfigured = splitCsv(
    env.AGENTIC_COMMIT_VERIFY_REMOTES ?? env.VALUA_COMMIT_VERIFY_REMOTES ?? 'origin,github',
  );
  const allowedRemotes = allowedConfigured.filter((name) => availableRemotes.includes(name));
  const upstreamRemote = await readUpstreamRemote({ cwd, env });
  const attemptedRemotes = uniq([
    allowedRemotes.includes(upstreamRemote) ? upstreamRemote : '',
    ...allowedRemotes,
  ]);

  if (attemptedRemotes.length === 0) {
    return {
      checked: false,
      reachable: true,
      reason: 'no_allowed_remote',
      commitSha: sha,
      attemptedRemotes: [],
      remoteRefs: [],
      errors: [],
      availableRemotes,
      allowedConfigured,
    };
  }

  const errors = [];
  let hadSuccessfulFetch = false;
  for (const remote of attemptedRemotes) {
    const fetched = await fetchRemote({ cwd, env, remote });
    if (!fetched.ok) {
      errors.push({ remote, phase: 'fetch', error: fetched.error });
      continue;
    }
    hadSuccessfulFetch = true;

    const refs = await listRemoteRefsContaining({ cwd, env, commitSha: sha, remote });
    if (refs.length > 0) {
      return {
        checked: true,
        reachable: true,
        reason: 'reachable',
        commitSha: sha,
        attemptedRemotes,
        remoteRefs: refs,
        errors,
      };
    }
  }

  if (!hadSuccessfulFetch && errors.some((e) => e.phase === 'fetch')) {
    return {
      checked: false,
      reachable: true,
      reason: 'fetch_unavailable',
      commitSha: sha,
      attemptedRemotes,
      remoteRefs: [],
      errors,
    };
  }

  return {
    checked: true,
    reachable: false,
    reason: 'not_found_on_allowed_remotes',
    commitSha: sha,
    attemptedRemotes,
    remoteRefs: [],
    errors,
  };
}
