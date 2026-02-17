import childProcess from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(childProcess.execFile);

/**
 * Helper for uniq used by the cockpit workflow runtime.
 */
function uniq(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

/**
 * Helper for split csv used by the cockpit workflow runtime.
 */
function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parses upstream remote name into a normalized value.
 */
function parseUpstreamRemoteName(upstreamRef) {
  const raw = String(upstreamRef || '').trim();
  if (!raw) return '';
  const slash = raw.indexOf('/');
  if (slash <= 0) return '';
  return raw.slice(0, slash).trim();
}

/**
 * Reads stdout from disk or process state.
 */
async function readStdout(cmd, args, { cwd, env }) {
  try {
    const res = await execFile(cmd, args, { cwd, env, maxBuffer: 4 * 1024 * 1024 });
    return String(res.stdout || '').trim();
  } catch (err) {
    return String(err?.stdout || '').trim();
  }
}

/**
 * Lists git remotes from available sources.
 */
async function listGitRemotes({ cwd, env }) {
  const out = await readStdout('git', ['remote'], { cwd, env });
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Reads upstream remote from disk or process state.
 */
async function readUpstreamRemote({ cwd, env }) {
  const upstream = await readStdout('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    cwd,
    env,
  });
  return parseUpstreamRemoteName(upstream);
}

/**
 * Helper for summarize exec error used by the cockpit workflow runtime.
 */
function summarizeExecError(err) {
  const stderr = String(err?.stderr || '').trim();
  if (stderr) return stderr;
  const stdout = String(err?.stdout || '').trim();
  if (stdout) return stdout;
  return (err && err.message) || String(err);
}

/**
 * Helper for fetch remote used by the cockpit workflow runtime.
 */
async function fetchRemote({ cwd, env, remote }) {
  try {
    await execFile('git', ['fetch', remote, '--prune'], { cwd, env, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: summarizeExecError(err) };
  }
}

/**
 * Lists remote refs containing from available sources.
 */
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

  const availableRemotes = await listGitRemotes({ cwd, env });
  const allowedConfigured = splitCsv(
    env.VALUA_COMMIT_VERIFY_REMOTES ?? env.AGENTIC_COMMIT_VERIFY_REMOTES ?? 'origin,github',
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
  for (const remote of attemptedRemotes) {
    const fetched = await fetchRemote({ cwd, env, remote });
    if (!fetched.ok) {
      errors.push({ remote, phase: 'fetch', error: fetched.error });
      continue;
    }

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

