# Tau deployment helpers.
#
# This checkout (~/src/pi-tau) is the source of truth. pi loads the extension
# from the deployed copy at $(RUNTIME_DIR) — a content mirror WITHOUT a .git.
# Never edit files in the runtime copy directly; change them here and run
# `make deploy` to push them out, or `make verify` to check for drift.
#
#   make deploy            # copy, stamp, verify, and smoke-test the runtime
#   make verify            # content + commit marker must match this checkout
#   make smoke-test        # load only this deployed extension in a fresh pi
#   make deployed-commit   # show what is deployed

RUNTIME_DIR ?= $(HOME)/.pi/agent/local/pi-tau
SMOKE_SCRIPT ?= /home/dev/src/pi-session-analysis/scripts/predeploy_smoke.py
SMOKE_TIMEOUT ?= 90

# Files that are intentionally runtime-only and never deployed:
#   .deployed-commit  — deploy stamp (source commit + timestamp + notice)
#   README.md         — "deployed copy" notice, replaced by hand in the runtime
# The remaining excludes keep local junk out of the runtime.
RSYNC_EXCLUDES := \
	--exclude '.git/' \
	--exclude 'node_modules/' \
	--exclude 'tmp/' \
	--exclude '.eslintcache' \
	--exclude '.deployed-commit' \
	--exclude 'README.md'

.PHONY: deploy runtime-deps verify smoke-test deployed-commit

deploy:  ## Copy this checkout, verify it, and smoke-test the deployed extension
	@test -z "$$(git status --porcelain)" || { echo "ERROR: commit source changes before deploying" >&2; git status --short >&2; exit 1; }
	@test -d "$(RUNTIME_DIR)" || mkdir -p "$(RUNTIME_DIR)"
	@deleting=$$(rsync -nrc --delete $(RSYNC_EXCLUDES) ./ "$(RUNTIME_DIR)/" | grep '^deleting ' || true); \
	if [ -n "$$deleting" ]; then \
		echo "ERROR: $(RUNTIME_DIR) contains files not present in this checkout:" >&2; \
		echo "$$deleting" >&2; \
		echo "Move or remove them before deploying (they would be lost)." >&2; \
		exit 1; \
	fi
	rsync -a $(RSYNC_EXCLUDES) ./ "$(RUNTIME_DIR)/"
	@$(MAKE) --no-print-directory runtime-deps
	@printf 'deployed from: %s\nbranch: %s\ncommit: %s\ndeployed at: %s\n\nThis is a deployed artifact. Do not edit files here.\nEdit the source checkout and run `make deploy`.\n' \
		"$(CURDIR)" "$$(git rev-parse --abbrev-ref HEAD)" "$$(git rev-parse HEAD)" "$$(date '+%Y-%m-%d %H:%M:%S %z')" \
		> "$(RUNTIME_DIR)/.deployed-commit"
	@$(MAKE) --no-print-directory verify
	@$(MAKE) --no-print-directory smoke-test

runtime-deps:  ## Install locked production dependencies into the deployed copy
	@test -f "$(RUNTIME_DIR)/package.json" || { echo "ERROR: deployed package.json missing" >&2; exit 1; }
	@test -f "$(RUNTIME_DIR)/pnpm-lock.yaml" || { echo "ERROR: deployed pnpm-lock.yaml missing" >&2; exit 1; }
	pnpm --dir "$(RUNTIME_DIR)" install --prod --frozen-lockfile --ignore-scripts

smoke-test:  ## Load only the deployed extension in a fresh pi process
	python3 "$(SMOKE_SCRIPT)" --extension "$(RUNTIME_DIR)" --tool jobs \
		--timeout "$(SMOKE_TIMEOUT)" \
		--prompt 'Call jobs with action list, report that it loaded, and stop.'

verify:  ## Verify runtime files match this checkout (content + commit marker)
	@test -d "$(RUNTIME_DIR)" || { echo "ERROR: $(RUNTIME_DIR) missing" >&2; exit 1; }
	@test -f "$(RUNTIME_DIR)/.deployed-commit" || { echo "ERROR: no .deployed-commit marker in $(RUNTIME_DIR)" >&2; exit 1; }
	@test "$$(sed -n 's/^commit: //p' "$(RUNTIME_DIR)/.deployed-commit")" = "$$(git rev-parse HEAD)" || { \
		echo "ERROR: deployed commit != checkout HEAD" >&2; exit 1; }
	@diff=$$(rsync -nrc $(RSYNC_EXCLUDES) ./ "$(RUNTIME_DIR)/" 2>&1); rc=$$?; \
	if [ $$rc -ne 0 ] && [ $$rc -ne 1 ]; then echo "rsync error: $$diff" >&2; exit 1; fi; \
	if [ -n "$$diff" ]; then echo "ERROR: content drift:" >&2; echo "$$diff" >&2; exit 1; fi
	@echo "OK: $(RUNTIME_DIR) matches $(CURDIR) @ $$(git rev-parse --short HEAD)"

deployed-commit:  ## Show which commit is deployed
	@cat "$(RUNTIME_DIR)/.deployed-commit" 2>/dev/null || echo "no .deployed-commit marker in $(RUNTIME_DIR)"
