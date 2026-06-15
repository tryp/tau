.PHONY: deploy verify verify-deploy

RUNTIME_DIR := /home/dev/.pi/agent/local/pi-tau

# Deploy fork to runtime by syncing src/ and key root files
deploy:
	rsync -a --delete src/ $(RUNTIME_DIR)/src/
	rsync -a index.ts package.json tsconfig.json $(RUNTIME_DIR)/
	@echo "Deployed pi-tau fork to $(RUNTIME_DIR)"
	@echo "Run 'make verify-deploy' to confirm."

# Verify the deployed files match the source
verify-deploy:
	@echo "=== Checking src/ ==="
	@diff -rq src/ $(RUNTIME_DIR)/src/ || echo "WARNING: src/ differs"
	@echo "=== Checking root files ==="
	@for f in index.ts package.json tsconfig.json; do \
		if ! diff -q "$$f" "$(RUNTIME_DIR)/$$f" >/dev/null 2>&1; then \
			echo "WARNING: $$f differs"; \
		fi; \
	done
	@echo "=== Verification complete ==="

# Verify the runtime is using this fork
verify:
	@echo "Runtime: $(RUNTIME_DIR)"
	@cd $(RUNTIME_DIR) && echo "  Branch: $$(git branch --show-current 2>/dev/null || echo 'not a git repo')"
	@cd $(RUNTIME_DIR) && echo "  Remote: $$(git remote get-url origin 2>/dev/null || echo 'no origin')"
	@echo "Fork: $$(pwd)"
	@git branch --show-current 2>/dev/null || echo "not a git repo"
	@git remote -v 2>/dev/null | head -2
