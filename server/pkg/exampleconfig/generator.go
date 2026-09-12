package exampleconfig

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/friendsfriend/devenv/pkg/resources"
)

type Generator struct {
	ConfigDir string
	HomeDir   string
}

func New() (Generator, error) {
	home, err := resources.ResolveHomeDir("")
	if err != nil {
		return Generator{}, err
	}
	return Generator{ConfigDir: resources.ResolveConfigDir(), HomeDir: home}, nil
}

func (g Generator) Generate() error {
	if err := ensureEmptyConfigDir(g.ConfigDir); err != nil {
		return err
	}
	scriptsDir := filepath.Join(g.HomeDir, "scripts")
	if err := ensureEmpty(scriptsDir, "scripts directory", scriptsDir); err != nil {
		return err
	}
	for path, content := range g.files() {
		if path == filepath.Join(g.ConfigDir, ".env") {
			if _, err := os.Stat(path); err == nil {
				continue
			} else if !os.IsNotExist(err) {
				return err
			}
		}
		mode := fs.FileMode(0644)
		if filepath.Dir(path) == scriptsDir || filepath.Ext(path) == ".sh" && (filepath.Dir(filepath.Dir(path)) == filepath.Join(g.ConfigDir, "apps") || filepath.Dir(path) == filepath.Join(g.ConfigDir, "infrastructure", "scripts")) {
			mode = 0755
		}
		if err := writeFile(path, content, mode); err != nil {
			return err
		}
	}
	return nil
}

func ensureEmptyConfigDir(dir string) error {
	return ensureEmpty(dir, "config directory", dir)
}

func ensureEmpty(dir, label, root string) error {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if ignoredConfigPath(path, root) {
			continue
		}
		if !entry.IsDir() {
			if ignoredConfigPath(path, root) {
				continue
			}
			return fmt.Errorf("%s %q is not empty; move existing files or choose a clean directory", label, dir)
		}
		if err := ensureEmpty(path, label, root); err != nil {
			return err
		}
	}
	return nil
}

func ignoredConfigPath(path, root string) bool {
	for _, ignored := range []string{
		filepath.Join(root, ".env"),
		filepath.Join(root, "providers"),
		filepath.Join(root, "tui.json"),
	} {
		if path == ignored {
			return true
		}
	}
	return false
}

func writeFile(path, content string, mode fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), mode)
}

func (g Generator) files() map[string]string {
	c, h, s := g.ConfigDir, g.HomeDir, filepath.Join(g.HomeDir, "scripts")
	return map[string]string{
		filepath.Join(c, ".env"): "DEVENV_HOME=" + h + "\n",
		filepath.Join(c, "apps", "definitions", "go-rest-postgres.json"):                      `{"ident":"go-rest-postgres","displayName":"Go REST Postgres","repositoryPath":"https://github.com/pauljamescleary/go-rest-postgres.git","containerBaseName":"go-rest-postgres","sourceType":"git","gitMode":"BRANCH"}` + "\n",
		filepath.Join(c, "apps", "definitions", "bhvr-site.json"):                             `{"ident":"bhvr-site","displayName":"Bun TypeScript App","repositoryPath":"https://github.com/stevedylandev/bhvr-site.git","containerBaseName":"bhvr-site","sourceType":"git","gitMode":"BRANCH"}` + "\n",
		filepath.Join(c, "apps", "definitions", "event-worker.json"):                          `{"ident":"event-worker","displayName":"Event Worker","repositoryPath":"https://github.com/wobsoriano/bun-lib-starter.git","containerBaseName":"event-worker","sourceType":"git","gitMode":"BRANCH"}` + "\n",
		filepath.Join(c, "apps", "definitions", "runtime-dependency-check.json"):              runtimeDependencyCheckAppDefinition,
		filepath.Join(c, "libraries", "definitions", "bun-lib-starter.json"):                  `{"ident":"bun-lib-starter","displayName":"Bun Library Starter","repositoryPath":"https://github.com/wobsoriano/bun-lib-starter.git","containerBaseName":"bun-lib-starter","sourceType":"git","gitMode":"BRANCH"}` + "\n",
		filepath.Join(c, "infrastructure", "definitions", "postgres.json"):                    `{"ident":"postgres","displayName":"Postgres","containerBaseName":"example-postgres"}` + "\n",
		filepath.Join(c, "infrastructure", "definitions", "redis.json"):                       `{"ident":"redis","displayName":"Redis","containerBaseName":"example-redis"}` + "\n",
		filepath.Join(c, "infrastructure", "definitions", "mailpit.json"):                     `{"ident":"mailpit","displayName":"Mailpit","containerBaseName":"example-mailpit"}` + "\n",
		filepath.Join(c, "infrastructure", "definitions", "script-clock.json"):                `{"ident":"script-clock","displayName":"Script Clock","type":"script","shellPath":"` + filepath.Join(c, "infrastructure", "scripts", "script-clock.sh") + `","cwd":"` + c + `","args":["--interval","2"],"env":{"DEVENV_EXAMPLE":"true"}}` + "\n",
		filepath.Join(c, "infrastructure", "definitions", "runtime-check-powershell.json"):    runtimeCheckPowerShellDefinition,
		filepath.Join(c, "infrastructure", "definitions", "runtime-check-k8s-docker.json"):    runtimeCheckKubernetesDockerDefinition,
		filepath.Join(c, "infrastructure", "definitions", "runtime-check-k8s-podman.json"):    runtimeCheckKubernetesPodmanDefinition,
		filepath.Join(c, "infrastructure", "definitions", "postgres-k8s.json"):                `{"ident":"postgres-k8s","displayName":"Postgres (Kubernetes)","type":"kubernetes","kubernetes":{"profile":"local","chartPath":"` + filepath.Join(c, "infrastructure", "k8s", "postgres") + `","release":"postgres-local","namespace":"infra","values":["` + filepath.Join(c, "infrastructure", "k8s", "postgres", "values.yaml") + `"],"wait":true,"timeout":"5m"}}` + "\n",
		filepath.Join(c, "apps", "compose", "go-rest-postgres-compose.yml"):                   goCompose,
		filepath.Join(c, "apps", "compose", "bhvr-site-compose.yml"):                          bunCompose,
		filepath.Join(c, "apps", "compose", "bhvr-site-debug-compose.yml"):                    bunDebugCompose,
		filepath.Join(c, "apps", "compose", "bhvr-site-with-redis-compose.yml"):               bunRedisCompose,
		filepath.Join(c, "apps", "compose", "event-worker-compose.yml"):                       eventWorkerCompose,
		filepath.Join(c, "infrastructure", "compose", "postgres-compose.yml"):                 postgresCompose,
		filepath.Join(c, "infrastructure", "compose", "redis-compose.yml"):                    redisCompose,
		filepath.Join(c, "infrastructure", "compose", "mailpit-compose.yml"):                  mailpitCompose,
		filepath.Join(c, "infrastructure", "scripts", "script-clock.sh"):                      scriptClockShellScript,
		filepath.Join(c, "infrastructure", "scripts", "runtime-check-powershell.ps1"):         runtimeCheckPowerShellScript,
		filepath.Join(c, "apps", "k8s", "bhvr-site", "devenv.k8s.json"):                       bunKubernetesConfig,
		filepath.Join(c, "apps", "k8s", "bhvr-site", "values.yaml"):                           bunKubernetesValues,
		filepath.Join(c, "apps", "k8s", "bhvr-site", "chart", "Chart.yaml"):                   bunKubernetesChart,
		filepath.Join(c, "apps", "k8s", "bhvr-site", "chart", "values.yaml"):                  bunKubernetesValues,
		filepath.Join(c, "apps", "k8s", "bhvr-site", "chart", "templates", "deployment.yaml"): bunKubernetesDeployment,
		filepath.Join(c, "apps", "k8s", "bhvr-site", "chart", "templates", "service.yaml"):    bunKubernetesService,
		filepath.Join(c, "infrastructure", "k8s", "postgres", "Chart.yaml"):                   postgresKubernetesChart,
		filepath.Join(c, "infrastructure", "k8s", "postgres", "values.yaml"):                  postgresKubernetesValues,
		filepath.Join(c, "infrastructure", "k8s", "postgres", "templates", "deployment.yaml"): postgresKubernetesDeployment,
		filepath.Join(c, "infrastructure", "k8s", "postgres", "templates", "service.yaml"):    postgresKubernetesService,
		filepath.Join(c, "apps", "build", "go-rest-postgres-build.Dockerfile"):                goBuildDockerfile,
		filepath.Join(c, "apps", "build", "go-rest-postgres-test.Dockerfile"):                 goTestDockerfile,
		filepath.Join(c, "apps", "build", "bhvr-site-build.Dockerfile"):                       bunBuildDockerfile,
		filepath.Join(c, "apps", "build", "bhvr-site-test.Dockerfile"):                        bunTestDockerfile,
		filepath.Join(c, "apps", "build", "bhvr-site-build.sh"):                               bunBuildShellScript,
		filepath.Join(c, "apps", "build", "bhvr-site-test.sh"):                                bunTestShellScript,
		filepath.Join(c, "apps", "build", "bhvr-site-build.ps1"):                              bunBuildPowerShellScript,
		filepath.Join(c, "apps", "build", "bhvr-site-test.ps1"):                               bunTestPowerShellScript,
		filepath.Join(c, "apps", "run", "bhvr-site-dev.sh"):                                   bunRunShellScript,
		filepath.Join(c, "apps", "run", "bhvr-site-dev.ps1"):                                  bunRunPowerShellScript,
		filepath.Join(c, "apps", "run", "event-worker-dev.sh"):                                eventWorkerRunShellScript,
		filepath.Join(c, "apps", "run", "event-worker-dev.ps1"):                               eventWorkerRunPowerShellScript,
		filepath.Join(c, "apps", "run", "runtime-dependency-check-docker-k8s-powershell.sh"):  runtimeCheckDockerScript,
		filepath.Join(c, "apps", "run", "runtime-dependency-check-podman-k8s-shell.sh"):       runtimeCheckPodmanScript,
		filepath.Join(c, "apps", "build", "bun-lib-starter-build.Dockerfile"):                 bunLibBuildDockerfile,
		filepath.Join(c, "apps", "build", "bun-lib-starter-test.Dockerfile"):                  bunLibTestDockerfile,
		filepath.Join(s, "hello.sh"):                                                          helloShellScript,
		filepath.Join(s, "hello.ps1"):                                                         helloPowerShellScript,
		filepath.Join(s, "hello.py"):                                                          helloPythonScript,
		filepath.Join(s, "hello.ts"):                                                          helloTypescriptScript,
	}
}

const bunBuildShellScript = `#!/usr/bin/env sh
# devenv:name=Local Build
# devenv:mode=logged
set -eu
bun install --frozen-lockfile || bun install
bun run build
`

const bunTestShellScript = `#!/usr/bin/env sh
# devenv:name=Local Test
# devenv:mode=logged
set -eu
bun install --frozen-lockfile || bun install
bun test
`

const bunRunShellScript = `#!/usr/bin/env sh
# devenv:name=Dev Server (complex deps)
# devenv:mode=tmux
# Shared infra: redis and script-clock. Unique infra: mailpit.
# App deps: go-rest-postgres via Docker default profile, event-worker via systemshell dev profile.
# devenv:requires=[{"app":"go-rest-postgres","runtime":"docker","profile":"default"},{"app":"event-worker","runtime":"systemshell","profile":"dev"},{"infra":"redis"},{"infra":"script-clock"},{"infra":"mailpit"}]
set -eu
bun run dev
`

const bunBuildPowerShellScript = `# devenv:name=Local Build (PowerShell)
# devenv:mode=logged
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { bun install; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
bun run build
exit $LASTEXITCODE
`

const bunTestPowerShellScript = `# devenv:name=Local Test (PowerShell)
# devenv:mode=logged
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { bun install; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
bun test
exit $LASTEXITCODE
`

const bunRunPowerShellScript = `# devenv:name=Dev Server (PowerShell complex deps)
# devenv:mode=tmux
# Shared infra: redis. Unique infra: mailpit.
# devenv:requires=[{"app":"go-rest-postgres","runtime":"docker","profile":"default"},{"app":"event-worker","runtime":"systemshell","profile":"dev"},{"infra":"redis"},{"infra":"mailpit"}]
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
bun run dev
exit $LASTEXITCODE
`

const eventWorkerRunShellScript = `#!/usr/bin/env sh
# devenv:name=Event Worker (system shell)
# devenv:mode=tmux
# Shared infra with bhvr-site: redis and script-clock. Shared Docker infra with go-rest-postgres: postgres.
# devenv:requires=[{"infra":"postgres"},{"infra":"redis"},{"infra":"script-clock"}]
set -eu
echo "Event worker consuming jobs with Redis and Postgres"
while true; do sleep 10; done
`

const eventWorkerRunPowerShellScript = `# devenv:name=Event Worker (PowerShell)
# devenv:mode=tmux
# Windows drift example: worker needs postgres and redis, but not script-clock.
# devenv:requires=[{"infra":"postgres"},{"infra":"redis"}]
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Write-Host "Event worker consuming jobs with Redis and Postgres"
while ($true) { Start-Sleep -Seconds 10 }
`

const scriptClockShellScript = `#!/usr/bin/env sh
set -eu
interval="2"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --interval) interval="${2:-2}"; shift 2 ;;
    *) shift ;;
  esac
done
echo "Script Clock starting (DEVENV_EXAMPLE=${DEVENV_EXAMPLE:-false})"
while true; do
  date '+script-clock %Y-%m-%dT%H:%M:%S%z'
  sleep "$interval"
done
`

const runtimeDependencyCheckAppDefinition = `{"ident":"runtime-dependency-check","displayName":"Runtime Dependency Check","repositoryPath":"https://github.com/friendsfriend/devenv.git","containerBaseName":"runtime-dependency-check","sourceType":"git","gitMode":"BRANCH"}
`

const runtimeCheckPowerShellDefinition = `{"ident":"runtime-check-powershell","displayName":"Runtime Check PowerShell","type":"script","powerShellPath":"$CONFIG/infrastructure/scripts/runtime-check-powershell.ps1","defaultRunner":"powershell","cwd":"$CONFIG"}
`

const runtimeCheckKubernetesDockerDefinition = `{"ident":"runtime-check-k8s-docker","displayName":"Runtime Check Kubernetes (Docker)","type":"kubernetes","kubernetes":{"profile":"local","provider":"docker","cluster":"runtime-check-docker","context":"kind-runtime-check-docker","chartPath":"$CONFIG/infrastructure/k8s/postgres","release":"runtime-check-postgres-docker","namespace":"runtime-check-docker","values":["$CONFIG/infrastructure/k8s/postgres/values.yaml"],"wait":true,"timeout":"5m"}}
`

const runtimeCheckKubernetesPodmanDefinition = `{"ident":"runtime-check-k8s-podman","displayName":"Runtime Check Kubernetes (Podman)","type":"kubernetes","kubernetes":{"profile":"local","provider":"podman","cluster":"runtime-check-podman","context":"kind-runtime-check-podman","chartPath":"$CONFIG/infrastructure/k8s/postgres","release":"runtime-check-postgres-podman","namespace":"runtime-check-podman","values":["$CONFIG/infrastructure/k8s/postgres/values.yaml"],"wait":true,"timeout":"5m"}}
`

const runtimeCheckPowerShellScript = `$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Write-Output "Runtime Check PowerShell dependency started"
while ($true) { Start-Sleep -Seconds 60 }
`

const runtimeCheckDockerScript = `#!/usr/bin/env sh
# devenv:name=Check Docker, Kubernetes, and PowerShell dependencies
# devenv:mode=logged
# devenv:requires=[{"infra":"runtime-check-powershell","runtime":"powershell","profile":"default","lifecycle":"shared"},{"infra":"postgres","runtime":"docker","profile":"default","provider":"docker","lifecycle":"shared"},{"infra":"runtime-check-k8s-docker","runtime":"kubernetes","profile":"local","provider":"docker","lifecycle":"shared"}]
set -eu

fail() { printf 'Dependency check failed: %s\n' "$1" >&2; exit 1; }
pgrep -f 'runtime-check-powershell.ps1' >/dev/null || fail 'PowerShell dependency is not running'
docker inspect --format '{{.State.Running}}' example-postgres 2>/dev/null | grep -qx true || fail 'Docker Postgres is not running'
kubectl --context kind-runtime-check-docker --namespace runtime-check-docker wait --for=condition=ready pod -l app.kubernetes.io/instance=runtime-check-postgres-docker --timeout=5s >/dev/null || fail 'Docker Kubernetes dependency is not ready'
printf '\n  ____  _   _  ____ ____ _____ ____ ____\n / ___|| | | |/ ___/ ___| ____/ ___/ ___|\n \\___ \\| | | | |  | |   |  _| \\___ \\___ \\\n  ___) | |_| | |__| |___| |___ ___) |__) |\n |____/ \\___/ \\____\\____|_____|____/____/\n\n Docker + Kubernetes + PowerShell dependencies are ready.\n'
`

const runtimeCheckPodmanScript = `#!/usr/bin/env sh
# devenv:name=Check Podman, Kubernetes, and shell dependencies
# devenv:mode=logged
# devenv:requires=[{"infra":"script-clock","runtime":"shell","profile":"default","lifecycle":"shared"},{"infra":"redis","runtime":"docker","profile":"default","provider":"podman","lifecycle":"shared"},{"infra":"runtime-check-k8s-podman","runtime":"kubernetes","profile":"local","provider":"podman","lifecycle":"shared"}]
set -eu

fail() { printf 'Dependency check failed: %s\n' "$1" >&2; exit 1; }
pgrep -f 'script-clock.sh' >/dev/null || fail 'Shell dependency is not running'
podman inspect --format '{{.State.Running}}' example-redis 2>/dev/null | grep -qx true || fail 'Podman Redis is not running'
kubectl --context kind-runtime-check-podman --namespace runtime-check-podman wait --for=condition=ready pod -l app.kubernetes.io/instance=runtime-check-postgres-podman --timeout=5s >/dev/null || fail 'Podman Kubernetes dependency is not ready'
printf '\n  ____  _   _  ____ ____ _____ ____ ____\n / ___|| | | |/ ___/ ___| ____/ ___/ ___|\n \\___ \\| | | | |  | |   |  _| \\___ \\___ \\\n  ___) | |_| | |__| |___| |___ ___) |__) |\n |____/ \\___/ \\____\\____|_____|____/____/\n\n Podman + Kubernetes + shell dependencies are ready.\n'
`

const helloShellScript = `#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--devenv-metadata" ]]; then
  cat <<'JSON'
[
  {"name":"name","type":"string","required":true,"description":"Name to greet","defaultValue":"DevEnv","flag":"--name"},
  {"name":"environment","type":"enum","required":true,"description":"Target environment","defaultValue":"dev","choices":["dev","test","prod"],"flag":"--env"},
  {"name":"excited","type":"bool","required":false,"description":"Add extra enthusiasm","flag":"--excited"}
]
JSON
  exit 0
fi

name="DevEnv"
environment="dev"
excited=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) name="${2:-DevEnv}"; shift 2 ;;
    --env) environment="${2:-dev}"; shift 2 ;;
    --excited) excited=true; shift ;;
    *) shift ;;
  esac
done

suffix="."
if [[ "$excited" == true ]]; then suffix="!"; fi
echo "Hello ${name} from ${environment}${suffix}"
`

const helloPowerShellScript = `#!/usr/bin/env pwsh
if ($args -contains "--devenv-metadata") {
  @'
[
  {"name":"name","type":"string","required":true,"description":"Name to greet","defaultValue":"DevEnv","flag":"--name"},
  {"name":"environment","type":"enum","required":true,"description":"Target environment","defaultValue":"dev","choices":["dev","test","prod"],"flag":"--env"},
  {"name":"excited","type":"bool","required":false,"description":"Add extra enthusiasm","flag":"--excited"}
]
'@ | Write-Output
  exit 0
}

$name = "DevEnv"
$environment = "dev"
$excited = $false
for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    "--name" { if ($i + 1 -lt $args.Count) { $name = $args[++$i] } }
    "--env" { if ($i + 1 -lt $args.Count) { $environment = $args[++$i] } }
    "--excited" { $excited = $true }
  }
}

$suffix = if ($excited) { "!" } else { "." }
Write-Output "Hello $name from $environment$suffix"
`

const helloPythonScript = `#!/usr/bin/env python3
import argparse
import json
import sys

if "--devenv-metadata" in sys.argv:
    print(json.dumps([
        {"name":"count","type":"int","required":true,"description":"How many greetings to print","defaultValue":"3","flag":"--count"},
        {"name":"style","type":"enum","required":false,"description":"Greeting style","defaultValue":"friendly","choices":["friendly","formal"],"flag":"--style"},
    ]))
    raise SystemExit(0)

parser = argparse.ArgumentParser()
parser.add_argument("--count", type=int, default=3)
parser.add_argument("--style", choices=["friendly", "formal"], default="friendly")
args = parser.parse_args()
message = "Hello from DevEnv Python" if args.style == "friendly" else "Greetings from DevEnv Python"
for _ in range(args.count):
    print(message)
`

const helloTypescriptScript = `#!/usr/bin/env bun
if (process.argv.includes("--devenv-metadata")) {
  console.log(JSON.stringify([
    { name: "service", type: "enum", required: true, description: "Service to inspect", defaultValue: "api", choices: ["api", "worker", "db"], flag: "--service" },
    { name: "verbose", type: "bool", required: false, description: "Print extra details", flag: "--verbose" },
  ]));
  process.exit(0);
}

const args = process.argv.slice(2);
const value = (flag: string, fallback: string) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] ?? fallback : fallback;
};
const service = value("--service", "api");
const verbose = args.includes("--verbose");
console.log("Checking " + service);
if (verbose) console.log("Verbose mode enabled");
`

const goCompose = `x-devenv:
  requires: [{"infra":"postgres"},{"infra":"script-clock"}]
services:
  go-rest-postgres:
    image: devenv-go-rest-postgres:latest
    environment:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/example?sslmode=disable
    ports: ["8080:8080"]
    networks: [example]
networks:
  example:
    name: devenv-example
    external: true
`

const bunCompose = `services:
  bhvr-site:
    image: devenv-bhvr-site:latest
    ports: ["3000:3000"]
`

const bunDebugCompose = `services:
  bhvr-site:
    image: devenv-bhvr-site:latest
    command: bun --inspect run dev
    ports: ["3000:3000", "6499:6499"]
`

const bunRedisCompose = `x-devenv:
  requires: [{"app":"go-rest-postgres","runtime":"docker","profile":"default"},{"infra":"redis"},{"infra":"script-clock"}]
services:
  bhvr-site:
    image: devenv-bhvr-site:latest
    environment:
      REDIS_URL: redis://bhvr-redis:6379
    ports: ["3000:3000"]
  bhvr-redis:
    image: redis:7-alpine
`

const eventWorkerCompose = `x-devenv:
  requires: [{"infra":"postgres"},{"infra":"redis"}]
services:
  event-worker:
    image: oven/bun:1
    command: sh -c "echo event-worker docker profile running && sleep infinity"
    environment:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/example?sslmode=disable
      REDIS_URL: redis://redis:6379
`

const postgresCompose = `services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: example
    ports: ["5432:5432"]
    networks: [example]
networks:
  example:
    name: devenv-example
`
const redisCompose = "services:\n  redis:\n    image: redis:7-alpine\n    ports: [\"6379:6379\"]\n"
const mailpitCompose = "services:\n  mailpit:\n    image: axllent/mailpit:latest\n    ports: [\"8025:8025\", \"1025:1025\"]\n"

const goBuildDockerfile = `FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /out/go-rest-postgres .

FROM alpine:3.22
LABEL devenv.artifacts="/out"
COPY --from=build /out /out
CMD ["/out/go-rest-postgres"]
`

const goTestDockerfile = `FROM golang:1.25-alpine
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go test ./...
`

const bunBuildDockerfile = `FROM oven/bun:1 AS deps
WORKDIR /src
COPY package.json bun.lock ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
COPY shared/package.json ./shared/package.json
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN bun run build

FROM oven/bun:1
LABEL devenv.artifacts="/src/client/dist"
WORKDIR /src
COPY --from=build /src /src
CMD ["bun", "run", "dev"]
`

const bunTestDockerfile = `FROM oven/bun:1
WORKDIR /src
COPY package.json bun.lock ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
COPY shared/package.json ./shared/package.json
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun test
`

const bunLibBuildDockerfile = `FROM oven/bun:1 AS deps
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run build

FROM scratch
LABEL devenv.artifacts="/out"
COPY --from=build /src/dist /out
`

const bunLibTestDockerfile = `FROM oven/bun:1
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun test
`

const bunKubernetesConfig = `{
  "targets": [
    {
      "profile": "k8s-local",
      "name": "Kubernetes Local (kind)",
      "chart": { "path": "$CONFIG/apps/k8s/bhvr-site/chart" },
      "values": ["$CONFIG/apps/k8s/bhvr-site/values.yaml"],
      "release": "bhvr-site-local",
      "namespace": "apps",
      "image": {
        "repository": "bhvr-site",
        "tag": "latest",
        "pullPolicy": "IfNotPresent",
        "valuePaths": { "repository": "image.repository", "tag": "image.tag", "pullPolicy": "image.pullPolicy" }
      },
      "ports": [{ "name": "http", "resource": "svc/bhvr-site", "localPort": 3000, "remotePort": 3000 }],
      "requires": [{ "infra": "postgres-k8s", "runtime": "kubernetes", "profile": "local" }],
      "wait": { "timeout": "5m" }
    }
  ]
}
`

const bunKubernetesValues = `image:
  repository: bhvr-site
  tag: latest
  pullPolicy: IfNotPresent
service:
  port: 3000
`

const postgresKubernetesChart = `apiVersion: v2
name: devenv-postgres
version: 0.1.0
type: application
`

const postgresKubernetesValues = `image:
  repository: postgres
  tag: "16-alpine"
service:
  port: 5432
env:
  POSTGRES_USER: devenv
  POSTGRES_PASSWORD: devenv
  POSTGRES_DB: devenv
`

const postgresKubernetesDeployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  labels:
    app.kubernetes.io/name: postgres
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: postgres
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: postgres
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      containers:
        - name: postgres
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          ports:
            - name: postgres
              containerPort: {{ .Values.service.port }}
          env:
            - name: POSTGRES_USER
              value: {{ .Values.env.POSTGRES_USER | quote }}
            - name: POSTGRES_PASSWORD
              value: {{ .Values.env.POSTGRES_PASSWORD | quote }}
            - name: POSTGRES_DB
              value: {{ .Values.env.POSTGRES_DB | quote }}
`

const postgresKubernetesService = `apiVersion: v1
kind: Service
metadata:
  name: postgres
  labels:
    app.kubernetes.io/name: postgres
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  selector:
    app.kubernetes.io/name: postgres
    app.kubernetes.io/instance: {{ .Release.Name }}
  ports:
    - name: postgres
      port: {{ .Values.service.port }}
      targetPort: postgres
`

const bunKubernetesChart = `apiVersion: v2
name: bhvr-site
version: 0.1.0
type: application
`

const bunKubernetesDeployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: bhvr-site
  labels:
    app.kubernetes.io/name: bhvr-site
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: bhvr-site
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: bhvr-site
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      containers:
        - name: bhvr-site
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: {{ .Values.service.port }}
`

const bunKubernetesService = `apiVersion: v1
kind: Service
metadata:
  name: bhvr-site
  labels:
    app.kubernetes.io/name: bhvr-site
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  selector:
    app.kubernetes.io/name: bhvr-site
    app.kubernetes.io/instance: {{ .Release.Name }}
  ports:
    - name: http
      port: {{ .Values.service.port }}
      targetPort: http
`
