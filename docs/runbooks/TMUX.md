# TMUX Runbook

## Start cockpit
`bash scripts/tmux/cockpit.sh up`

## Stop cockpit
`bash scripts/tmux/cockpit.sh down`

## Restart cockpit
`bash scripts/tmux/cockpit.sh restart`

## Respawn one worker pane

If the tmux session is still alive but a single worker pane died, respawn only that pane instead of nuking the whole cockpit.

Example: restart only `daddy-autopilot` in the default `valua-cockpit` session:

```bash
tmux respawn-pane -k -t valua-cockpit:cockpit.3 \
  "cd '$HOME/.codex/valua/worktrees/Valua/daddy-autopilot' && export AGENTIC_PROJECT_ROOT='$HOME/projects/.worktrees/valua-runtime-master' && export AGENTIC_BUS_DIR='$HOME/.codex/valua/agent-bus' && export AGENTIC_ROSTER_PATH='$HOME/projects/.worktrees/valua-runtime-master/docs/agentic/agent-bus/ROSTER.json' && export VALUA_REPO_ROOT='$HOME/projects/.worktrees/valua-runtime-master' && export VALUA_AGENT_BUS_DIR='$HOME/.codex/valua/agent-bus' && export VALUA_AGENT_ROSTER_PATH='$HOME/projects/.worktrees/valua-runtime-master/docs/agentic/agent-bus/ROSTER.json' && export AGENTIC_AUTOPILOT_INCLUDE_DEPLOY_JSON=1 && export VALUA_AUTOPILOT_INCLUDE_DEPLOY_JSON=1 && node '$HOME/projects/agentic-cockpit/scripts/agent-codex-worker.mjs' --agent daddy-autopilot"
```

Use the roster workdir/start command for other workers. Do not full-reset the cockpit just because one pane died.

## Notes
- Use a single session per project to avoid bus/roster confusion.
- Keep mouse mode enabled for pane navigation when desired.
