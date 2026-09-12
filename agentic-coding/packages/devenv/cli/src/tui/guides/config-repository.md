# Configuration Repository Guide

Use a configuration repository when you want to share DevEnv setup across machines or with a team.

## What goes into the repository

Commit the contents of:

```bash
~/.config/devenv
```

Do **not** commit the `.env` file. It can contain machine-specific paths and secrets.

Provider definitions in `providers/*.json` can be committed when they contain `${...}` placeholders for `username` and `token`. DevEnv-managed providers store actual credentials in `.env` and write placeholders into provider JSON. Clear-text credentials in provider JSON are blocked: startup continues, the provider is shown as invalid in the TUI, and credentials are unusable until migrated to `.env` placeholders.

Task collections are not part of the config directory. They live under `$DEVENV_HOME/scripts` (default `~/devenv/scripts`). Sync them separately if your team wants shared tasks.

Recommended `.gitignore`:

```gitignore
.env
```

Provider credentials stay local in `.env`; provider metadata can be shared through `providers/*.json`.

## 1. Create the repository

Create an empty Git repository in GitHub, GitLab, or another Git host.

Example:

```bash
mkdir devenv-config
cd devenv-config
git init
```

## 2. Copy your DevEnv config

Copy your current configuration into the repository:

```bash
cp -R ~/.config/devenv/. .
rm -f .env
```

If you do not have config yet, create the folders you want to share, for example:

```bash
mkdir -p apps/definitions apps/build apps/compose apps/run libraries/definitions infrastructure/definitions
```

Per-app action resources are shareable config files:

- Docker build/test: `apps/build/<ident>-build.Dockerfile`, `apps/build/<ident>-test.Dockerfile`
- Shell build/test: `apps/build/<ident>-build.sh`, `apps/build/<ident>-test.sh`
- Docker run: `apps/compose/<ident>-compose.yml`, `apps/compose/<ident>-<profile>-compose.yml`
- Shell run: `apps/run/<ident>-<profile>.sh`

Shell scripts can include metadata comments such as `# devenv:name=Dev Server` and `# devenv:mode=tmux`. Tmux run scripts require the DevEnv server to run inside tmux.

## 3. Ignore local-only files

Create `.gitignore`:

```bash
cat > .gitignore <<'EOF'
.env
EOF
```

## 4. Commit and push

```bash
git add .
git commit -m "Add DevEnv configuration"
git remote add origin YOUR_CONFIG_REPO_URL
git push -u origin main
```

## 5. Use it on another machine

Move any existing local config aside, then clone the repository:

```bash
mv ~/.config/devenv ~/.config/devenv.backup.$(date +%Y%m%d%H%M%S)
git clone YOUR_CONFIG_REPO_URL ~/.config/devenv
```

Create a local `.env` file if needed. Runtime choice is local; default is `docker`, use `podman` on Podman machines:

```bash
cat > ~/.config/devenv/.env <<'EOF'
DEVENV_HOME=$HOME/devenv
DEVENV_CONTAINER_RUNTIME=docker
EOF
```

## 6. Restart DevEnv

Quit and start DevEnv again. It will load applications, libraries, and infrastructure from the cloned config repository. Task collections still load from `$DEVENV_HOME/scripts`; copy or sync that directory separately if needed.

## Updating shared config

After adding or changing apps/infrastructure, commit and push the config changes:

```bash
cd ~/.config/devenv
git status
git add .
git commit -m "Update DevEnv config"
git push
```

On another machine:

```bash
cd ~/.config/devenv
git pull
```

Restart DevEnv after pulling changes.
