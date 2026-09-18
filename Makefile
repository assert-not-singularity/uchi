PLUGIN_DIR := $(HOME)/.config/omarchy/plugins/uchi
REPO_DIR := $(CURDIR)

# Quickshell's plugin loader rejects a bar-widget entry point reached through
# a symlinked plugin folder ("File name case mismatch" — the service kind
# tolerates it, bar-widget doesn't). A bind mount makes the folder look like
# a real directory to the loader while still editing the same files live.
# Re-run after every reboot — a bind mount doesn't persist on its own.
.PHONY: dev-mount
dev-mount:
	@if mountpoint -q "$(PLUGIN_DIR)"; then \
		echo "already mounted: $(PLUGIN_DIR)"; \
	else \
		mkdir -p "$(PLUGIN_DIR)"; \
		sudo mount --bind "$(REPO_DIR)" "$(PLUGIN_DIR)" && echo "mounted $(REPO_DIR) -> $(PLUGIN_DIR)"; \
	fi

.PHONY: dev-unmount
dev-unmount:
	@if mountpoint -q "$(PLUGIN_DIR)"; then \
		sudo umount "$(PLUGIN_DIR)"; \
		echo "unmounted $(PLUGIN_DIR)"; \
	else \
		echo "not mounted: $(PLUGIN_DIR)"; \
	fi
