export class TaskGitPreflightRuntimeError extends Error {
  constructor(message, { cwd = '', taskKind = '', contract = null, details = null } = {}) {
    super(message);
    this.name = 'TaskGitPreflightRuntimeError';
    this.cwd = cwd || null;
    this.taskKind = taskKind || null;
    this.contract = contract || null;
    this.details = details || null;
  }
}

export function createTaskGitPreflightRuntimeError({ error, cwd = '', taskKind = '', contract = null } = {}) {
  const runtimeMessage = (error && error.message) || String(error);
  return new TaskGitPreflightRuntimeError(`git preflight failed: ${runtimeMessage}`, {
    cwd,
    taskKind,
    contract,
    details: { error: runtimeMessage },
  });
}
