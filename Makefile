PLUGIN_DIR := $(HOME)/.config/omarchy/plugins/uchi
REPO_DIR := $(CURDIR)

# Omarchy's shell watches ~/.config/omarchy/plugins recursively (inotifywait,
# in PluginRegistry.qml) and reloads every plugin widget on any write under
# it, regardless of which plugin changed or whether it's enabled — there's no
# way to scope or disable that watch. Editing this repo in place, live at
# that path, means every single edit flickers the whole bar. Deploying is a
# copy instead: the repo stays untouched by the watcher while editing, and a
# single `make dev-deploy` is the one deliberate point where the shell
# reloads, picking up everything changed since the last deploy at once.
# Also sidesteps Quickshell's "File name case mismatch" error, which a
# symlinked (or bind-mounted) plugin folder triggers for a bar-widget entry
# point specifically — a real copied directory doesn't.
.PHONY: dev-deploy
dev-deploy:
	@mkdir -p "$(PLUGIN_DIR)"
	@rsync -a --delete --exclude=.git "$(REPO_DIR)/" "$(PLUGIN_DIR)/"
	@echo "deployed $(REPO_DIR) -> $(PLUGIN_DIR)"
