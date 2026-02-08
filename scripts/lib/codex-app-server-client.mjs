import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

function normalizeRequestId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function defaultServerRequestDecision({ method }) {
  // Non-interactive workers: match codex exec behavior (--ask-for-approval never) by auto-approving.
  if (method === 'item/commandExecution/requestApproval') return { decision: 'acceptForSession' };
  if (method === 'item/fileChange/requestApproval') return { decision: 'acceptForSession' };
  if (method === 'applyPatchApproval') return { decision: 'approved_for_session' };
  if (method === 'execCommandApproval') return { decision: 'approved_for_session' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'item/tool/call') return { success: false, output: 'dynamic tool calls are not implemented by this client' };
  return null;
}

export class CodexAppServerClient extends EventEmitter {
  /**
   * @param {{
   *   codexBin: string,
   *   cwd: string,
   *   env: Record<string, string>,
   *   log: (line: string) => void,
   * }} params
   */
  constructor({ codexBin, cwd, env, log }) {
    super();
    this._codexBin = codexBin;
    this._cwd = cwd;
    this._env = env;
    this._log = log;

    this._proc = null;
    this._nextId = 1;
    /** @type {Map<string|number, { resolve: Function, reject: Function }>} */
    this._pending = new Map();
    this._initialized = false;
  }

  /** @returns {boolean} */
  get isRunning() {
    return Boolean(this._proc && this._proc.exitCode == null);
  }

  /** @returns {number|null} */
  get pid() {
    return this._proc?.pid ?? null;
  }

  async start() {
    if (this.isRunning) return;
    const proc = spawn(this._codexBin, ['app-server'], {
      cwd: this._cwd,
      env: this._env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._proc = proc;

    proc.on('exit', (code, signal) => {
      this._log?.(`[app-server] exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
      this._proc = null;
      this._initialized = false;
      for (const [id, pending] of this._pending.entries()) {
        this._pending.delete(id);
        pending.reject(new Error('codex app-server exited while request was pending'));
      }
      this.emit('exit', { code, signal });
    });

    proc.on('error', (err) => {
      this._log?.(`[app-server] ERROR: ${(err && err.message) || String(err)}\n`);
      this._proc = null;
      this._initialized = false;
      for (const [id, pending] of this._pending.entries()) {
        this._pending.delete(id);
        pending.reject(err);
      }
    });

    proc.stderr.on('data', (chunk) => {
      this._log?.(chunk.toString('utf8'));
    });

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => this._handleLine(line));

    await this._initializeOnce();
  }

  async stop() {
    if (!this._proc) return;
    try {
      this._proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    this._proc = null;
    this._initialized = false;
  }

  async _initializeOnce() {
    if (this._initialized) return;
    const result = await this.call('initialize', {
      clientInfo: { name: 'agentic-cockpit', version: '0.1.0' },
    });
    // Client must notify initialized.
    this.notify('initialized');
    this._initialized = true;
    this.emit('initialized', result);
  }

  /**
   * @param {any} line
   */
  _handleLine(line) {
    const trimmed = String(line ?? '').trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this._log?.(`[app-server] WARN: non-JSON line: ${trimmed.slice(0, 200)}\n`);
      return;
    }

    // Response to our request.
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
      const id = normalizeRequestId(msg.id);
      const pending = id != null ? this._pending.get(id) : null;
      if (!pending) return;
      this._pending.delete(id);
      if (msg.error) {
        const m = isObject(msg.error) && typeof msg.error.message === 'string' ? msg.error.message : 'app-server error';
        pending.reject(new Error(m));
        return;
      }
      pending.resolve(msg.result);
      return;
    }

    // Notification or server-initiated request.
    if (typeof msg?.method === 'string') {
      const method = msg.method;
      const params = Object.prototype.hasOwnProperty.call(msg, 'params') ? msg.params : null;

      if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
        // Server request.
        const id = normalizeRequestId(msg.id);
        if (id == null) return;
        this._handleServerRequest({ id, method, params }).catch((err) => {
          this._log?.(`[app-server] ERROR: server request handler failed: ${(err && err.message) || String(err)}\n`);
          this._send({ id, error: { code: -32000, message: 'server request handler failed' } });
        });
        return;
      }

      // Server notification.
      this.emit('notification', { method, params, raw: msg });
      return;
    }
  }

  async _handleServerRequest({ id, method, params }) {
    this.emit('serverRequest', { id, method, params });
    const decision = defaultServerRequestDecision({ method, params });
    if (decision) {
      this._send({ id, result: decision });
      return;
    }
    this._send({ id, error: { code: -32601, message: `Unhandled server request method: ${method}` } });
  }

  _send(obj) {
    if (!this._proc || !this.isRunning) throw new Error('codex app-server is not running');
    this._proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  notify(method, params = undefined) {
    const msg = { method };
    if (params !== undefined) msg.params = params;
    this._send(msg);
  }

  call(method, params) {
    const id = this._nextId;
    this._nextId += 1;
    const msg = { id, method, params };
    this._send(msg);
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
    });
  }
}
