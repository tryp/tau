# pi-tau

Quality-of-life extension for pi: background tasks, tmux-backed job execution,
notifications, task management, and web browsing.

## Development model

- This checkout is the **source of truth**. All development happens here.
- pi loads the extension from the **deployed copy** at
  `~/.pi/agent/local/pi-tau` (see `~/.pi/agent/settings.json`). That directory
  is a content mirror **without a `.git`** — never edit files there, and never
  run git operations in it.
- Ship changes with `make deploy` (copies to the runtime, stamps
  `.deployed-commit` with the source commit, and verifies). Use `make verify`
  to check for drift and `make deployed-commit` to see what is deployed.

## Loading extensions: deploy, don't point at ~/src

Do **not** load `~/src/*` package copies directly in `~/.pi/agent/settings.json`
(for example `"/home/dev/src/pi-tau"`). Loading from a source tree puts
uncommitted or untested changes into the live pi environment immediately and
bypasses the deploy/verify workflow. Always deploy first (`make deploy`), then
load the deployed copy — so changes can be tested before they go live for
general use.

Known existing deviations (direct `~/src` loads) that should migrate to the
deploy model once they gain deploy workflows: `pi-vcc`, `pi-lsp-adapter`.
