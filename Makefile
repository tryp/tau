# Tau deployment helpers.
# The runtime loads this package directly from the local copy.

RUNTIME_DIR ?= $(HOME)/.pi/agent/local/pi-tau
RSYNC_EXCLUDES := \
	--exclude '.git/' \
	--exclude 'node_modules/' \
	--exclude 'tmp/' \
	--exclude '.eslintcache'

.PHONY: deploy verify

deploy:  ## Copy this checkout to the local pi runtime and verify it
	@test -d "$(RUNTIME_DIR)" || mkdir -p "$(RUNTIME_DIR)"
	rsync -a $(RSYNC_EXCLUDES) ./ "$(RUNTIME_DIR)/"
	@$(MAKE) --no-print-directory verify

verify:  ## Verify runtime files match this checkout
	@test -d "$(RUNTIME_DIR)"
	@diff=$$(rsync -nrc $(RSYNC_EXCLUDES) ./ "$(RUNTIME_DIR)/"); \
	if [ -n "$$diff" ]; then \
		echo "Runtime differs from $(CURDIR):" >&2; \
		echo "$$diff" >&2; \
		exit 1; \
	fi
	@echo "Verified $(RUNTIME_DIR)"
