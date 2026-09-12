# System Utilities Guide

DevEnv uses several system utilities. Some are required for core functionality; others enhance the experience or enable specific workflows.

## Required Utilities

These must be installed for DevEnv to function.

### Git

Version control system used by DevEnv for repository operations, worktrees, and all git integrations.

**Install:**

```bash
# macOS
brew install git

# Debian/Ubuntu
sudo apt install git

# Fedora/RHEL
sudo dnf install git
```

**DevEnv usage:** Clone, pull, push, branch, worktree operations, change request browsing, diff viewing, pipeline triggers.

### Docker or Podman

Container runtime for building, running, and managing application containers.

**Install Docker:**

```bash
# macOS — install Docker Desktop from https://www.docker.com/products/docker-desktop/

# Debian/Ubuntu
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out and back in

# Fedora/RHEL
sudo dnf install docker
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

**Install Podman:**

```bash
# macOS
brew install podman
podman machine init && podman machine start

# Debian/Ubuntu
sudo apt install podman

# Fedora/RHEL
sudo dnf install podman
```

**DevEnv usage:** Container lifecycle (start, stop, restart), log streaming, stats, build targets, Docker Compose operations. Set runtime via `DEVENV_CONTAINER_RUNTIME` in `~/.config/devenv/.env`.

See [Container Runtime Guide](container-runtime.md) for configuration details.

## Optional Enhanced Utilities

These improve the TUI experience when installed.

### lazygit

Terminal UI for git — provides a rich interactive interface for staging, committing, branching, and viewing diffs.

**Install:**

```bash
# macOS
brew install lazygit

# Debian/Ubuntu
LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
curl -Lo lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/latest/download/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
tar xf lazygit.tar.gz lazygit
sudo install lazygit /usr/local/bin

# Fedora/RHEL
LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
curl -Lo lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/latest/download/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
tar xf lazygit.tar.gz lazygit
sudo install lazygit /usr/local/bin
```

**DevEnv usage:** `Shift+G` opens lazygit for the selected repository. `g` opens the status panel in lazygit. `Shift+L` opens lazygit log for the selected branch. Launches in a tmux window when inside tmux.

### lazydocker

Terminal UI for docker — provides an interactive interface for viewing containers, logs, stats, and managing docker-compose services.

**Install:**

```bash
# macOS
brew install lazydocker

# Debian/Ubuntu
LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazydocker/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
curl -Lo lazydocker.tar.gz "https://github.com/jesseduffield/lazydocker/releases/latest/download/lazydocker_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
tar xf lazydocker.tar.gz lazydocker
sudo install lazydocker /usr/local/bin

# Fedora/RHEL
LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazydocker/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
curl -Lo lazydocker.tar.gz "https://github.com/jesseduffield/lazydocker/releases/latest/download/lazydocker_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
tar xf lazydocker.tar.gz lazydocker
sudo install lazydocker /usr/local/bin
```

**DevEnv usage:** `Shift+D` opens lazydocker for the selected application. Launches in a tmux window when inside tmux.

### pi

AI-powered coding agent integrated into DevEnv for code review, task execution, and assistance.

**Install:**

```bash
npm install -g @earendil-works/pi-coding-agent
```

**DevEnv usage:** AI session view, AI-assisted code review, task execution via the AI tab. See [Using AI Features](using-ai-features.md) for details.

## Optional Advanced Utilities

These are needed for specific workflows.

### kubectl

Kubernetes command-line tool for interacting with Kubernetes clusters.

**Install:**

```bash
# macOS
brew install kubectl

# Debian/Ubuntu
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Fedora/RHEL
sudo dnf install -y kubectl
```

**DevEnv usage:** Kubernetes app and infrastructure operations when using the Kubernetes runtime. Used for `kubectl apply`, `kubectl delete`, pod status, and log retrieval.

### Helm

Kubernetes package manager for deploying and managing Helm charts.

**Install:**

```bash
# macOS
brew install helm

# Debian/Ubuntu
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Fedora/RHEL
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

**DevEnv usage:** Helm-based app and infrastructure deployments. DevEnv uses `helm upgrade --install` and `helm uninstall` for managed Helm targets.

### kind

Kubernetes in Docker — runs local Kubernetes clusters using Docker containers as nodes.

**Install:**

```bash
# macOS
brew install kind

# Debian/Ubuntu
curl -Lo ./kind https://kind.sigs.k8s.io/dl/latest/kind-linux-amd64
chmod +x ./kind
sudo mv ./kind /usr/local/bin/kind

# Fedora/RHEL
curl -Lo ./kind https://kind.sigs.k8s.io/dl/latest/kind-linux-amd64
chmod +x ./kind
sudo mv ./kind /usr/local/bin/kind
```

**DevEnv usage:** DevEnv manages a `kind-devenv` cluster for Kubernetes runtime apps and infrastructure. Automatically creates and configures the cluster when needed.

### k9s

Terminal UI for Kubernetes — provides an interactive interface for browsing clusters, viewing pods, logs, and resources.

**Install:**

```bash
# macOS
brew install k9s

# Debian/Ubuntu
K9S_VERSION=$(curl -s "https://api.github.com/repos/derailed/k9s/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
curl -Lo k9s.tar.gz "https://github.com/derailed/k9s/releases/latest/download/k9s_Linux_amd64.tar.gz"
tar xf k9s.tar.gz k9s
sudo install k9s /usr/local/bin

# Fedora/RHEL
K9S_VERSION=$(curl -s "https://api.github.com/repos/derailed/k9s/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
curl -Lo k9s.tar.gz "https://github.com/derailed/k9s/releases/latest/download/k9s_Linux_amd64.tar.gz"
tar xf k9s.tar.gz k9s
sudo install k9s /usr/local/bin
```

**DevEnv usage:** `K` opens k9s connected to the `kind-devenv` context. Provides real-time Kubernetes resource monitoring and management.

### worktrunk

CLI tool for managing git worktrees across multiple repositories.

**Install:**

```bash
# macOS
brew install worktrunk

# Linux
cargo install worktrunk
```

**DevEnv usage:** Used with worktree-based workflows for managing branches across multiple repositories simultaneously. See [Using Worktrees](using-worktrees.md) for details.

### ssh

Secure Shell client for remote server access.

**Install:** SSH is pre-installed on macOS and most Linux distributions.

```bash
# Debian/Ubuntu (if missing)
sudo apt install openssh-client

# Fedora/RHEL (if missing)
sudo dnf install openssh-clients
```

**DevEnv usage:** Remote server access from the TUI. Parses `~/.ssh/config` for host definitions and provides an SSH host picker. Manages SSH agent key loading with passphrase support.
