# Valua adapter

This adapter runs Agentic Cockpit against a local Valua checkout.

It preserves Valua’s existing defaults where possible:
- bus root: `~/.codex/valua/agent-bus`
- worktrees: `~/.codex/valua/worktrees/Valua`

## Usage
```bash
bash adapters/valua/run.sh /path/to/Valua
```

Optional env overrides:
- `AGENTIC_BUS_DIR`
- `AGENTIC_WORKTREES_DIR`

Notes:
- The chat pane boot prompt defaults to `$valua-daddy-chat-io` (override via `VALUA_CODEX_CHAT_BOOT_PROMPT`).
