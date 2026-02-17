# Valua adapter

This adapter runs Agentic Cockpit against a local Valua checkout.

It preserves Valua’s existing defaults where possible:
- bus root: `~/.codex/valua/agent-bus`
- worktrees: `~/.codex/valua/worktrees/Valua`

## Usage
```bash
bash adapters/valua/run.sh /path/to/Valua
```

## Bootstrap (optional, fresh checkout only)
For a brand-new Valua checkout missing cockpit files, scaffold once:

```bash
node scripts/init-project.mjs --project /path/to/Valua
```

This seeds Valua-local:
- `docs/agentic/agent-bus/*`
- `docs/agentic/BLUEPRINT.md`
- `docs/runbooks/*`
- `.codex/skills/cockpit-*` baseline skills (plus verification skill)

Important:
- For an already-configured Valua repo, **do not run scaffold** in normal operation.
- The adapter uses Valua-local files directly; it does not auto-seed.
- `init-project` is only for bootstrapping missing files (it skips existing files unless `--force` is used).
- The adapter now fails fast if Valua roster is missing, to avoid accidental bundled fallback.

Optional env overrides:
- `AGENTIC_BUS_DIR`
- `AGENTIC_WORKTREES_DIR`
- `AGENTIC_PR_OBSERVER_MIN_PR` (default from adapter: `82`)
- `AGENTIC_POLICY_SYNC_ON_START` (default `1`, one-way root -> worktrees)

Notes:
- The chat pane boot prompt defaults to `$valua-daddy-chat-io` (override via `VALUA_CODEX_CHAT_BOOT_PROMPT`).
- The PR observer is constrained to PR `>= 82` by default for Valua adapter launches; override only if you intentionally need older PRs scanned.
- Startup runs one-way policy sync from Valua root into agent worktrees so skills/runbooks/roster stay current without reverse writes.
