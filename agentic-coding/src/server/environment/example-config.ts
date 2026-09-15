// Example configuration generator (`port-environment-runtimes-to-bun`, task 4.4).
//
// Ported from `server/pkg/exampleconfig/generator.go`. The template bodies are the
// Go constants verbatim (extracted, not retyped), so both implementations generate
// the same tree — a fixture written by either is byte-identical.
//
// The guard rules are load-bearing: a non-empty config or scripts directory is
// refused *before* anything is written, and `.env`, `providers/` and `tui.json`
// are never overwritten.
import fs from "node:fs";
import path from "node:path";

export interface ExampleConfigOptions {
	readonly configDir: string;
	readonly homeDir: string;
}

const bunBuildDockerfile =
	'FROM oven/bun:1 AS deps\nWORKDIR /src\nCOPY package.json bun.lock ./\nCOPY server/package.json ./server/package.json\nCOPY client/package.json ./client/package.json\nCOPY shared/package.json ./shared/package.json\nRUN bun install --frozen-lockfile --ignore-scripts\n\nFROM deps AS build\nCOPY . .\nRUN bun run build\n\nFROM oven/bun:1\nLABEL devenv.artifacts="/src/client/dist"\nWORKDIR /src\nCOPY --from=build /src /src\nCMD ["bun", "run", "dev"]\n';
const bunBuildPowerShellScript =
	'# devenv:name=Local Build (PowerShell)\n# devenv:mode=logged\n$ErrorActionPreference = "Stop"\nSet-StrictMode -Version Latest\nbun install --frozen-lockfile\nif ($LASTEXITCODE -ne 0) { bun install; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }\nbun run build\nexit $LASTEXITCODE\n';
const bunBuildShellScript =
	"#!/usr/bin/env sh\n# devenv:name=Local Build\n# devenv:mode=logged\nset -eu\nbun install --frozen-lockfile || bun install\nbun run build\n";
const bunCompose =
	'services:\n  bhvr-site:\n    image: devenv-bhvr-site:latest\n    ports: ["3000:3000"]\n';
const bunDebugCompose =
	'services:\n  bhvr-site:\n    image: devenv-bhvr-site:latest\n    command: bun --inspect run dev\n    ports: ["3000:3000", "6499:6499"]\n';
const bunKubernetesChart =
	"apiVersion: v2\nname: bhvr-site\nversion: 0.1.0\ntype: application\n";
const bunKubernetesConfig =
	'{\n  "targets": [\n    {\n      "profile": "k8s-local",\n      "name": "Kubernetes Local (kind)",\n      "chart": { "path": "$CONFIG/apps/k8s/bhvr-site/chart" },\n      "values": ["$CONFIG/apps/k8s/bhvr-site/values.yaml"],\n      "release": "bhvr-site-local",\n      "namespace": "apps",\n      "image": {\n        "repository": "bhvr-site",\n        "tag": "latest",\n        "pullPolicy": "IfNotPresent",\n        "valuePaths": { "repository": "image.repository", "tag": "image.tag", "pullPolicy": "image.pullPolicy" }\n      },\n      "ports": [{ "name": "http", "resource": "svc/bhvr-site", "localPort": 3000, "remotePort": 3000 }],\n      "requires": [{ "infra": "postgres-k8s", "runtime": "kubernetes", "profile": "local" }],\n      "wait": { "timeout": "5m" }\n    }\n  ]\n}\n';
const bunKubernetesDeployment =
	'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: bhvr-site\n  labels:\n    app.kubernetes.io/name: bhvr-site\n    app.kubernetes.io/instance: {{ .Release.Name }}\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app.kubernetes.io/name: bhvr-site\n      app.kubernetes.io/instance: {{ .Release.Name }}\n  template:\n    metadata:\n      labels:\n        app.kubernetes.io/name: bhvr-site\n        app.kubernetes.io/instance: {{ .Release.Name }}\n    spec:\n      containers:\n        - name: bhvr-site\n          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"\n          imagePullPolicy: {{ .Values.image.pullPolicy }}\n          ports:\n            - name: http\n              containerPort: {{ .Values.service.port }}\n';
const bunKubernetesService =
	"apiVersion: v1\nkind: Service\nmetadata:\n  name: bhvr-site\n  labels:\n    app.kubernetes.io/name: bhvr-site\n    app.kubernetes.io/instance: {{ .Release.Name }}\nspec:\n  selector:\n    app.kubernetes.io/name: bhvr-site\n    app.kubernetes.io/instance: {{ .Release.Name }}\n  ports:\n    - name: http\n      port: {{ .Values.service.port }}\n      targetPort: http\n";
const bunKubernetesValues =
	"image:\n  repository: bhvr-site\n  tag: latest\n  pullPolicy: IfNotPresent\nservice:\n  port: 3000\n";
const bunLibBuildDockerfile =
	'FROM oven/bun:1 AS deps\nWORKDIR /src\nCOPY package.json bun.lock ./\nRUN bun install --frozen-lockfile\n\nFROM deps AS build\nCOPY . .\nRUN bun run build\n\nFROM scratch\nLABEL devenv.artifacts="/out"\nCOPY --from=build /src/dist /out\n';
const bunLibTestDockerfile =
	"FROM oven/bun:1\nWORKDIR /src\nCOPY package.json bun.lock ./\nRUN bun install --frozen-lockfile\nCOPY . .\nRUN bun test\n";
const bunRedisCompose =
	'x-devenv:\n  requires: [{"app":"go-rest-postgres","runtime":"docker","profile":"default"},{"infra":"redis"},{"infra":"script-clock"}]\nservices:\n  bhvr-site:\n    image: devenv-bhvr-site:latest\n    environment:\n      REDIS_URL: redis://bhvr-redis:6379\n    ports: ["3000:3000"]\n  bhvr-redis:\n    image: redis:7-alpine\n';
const bunRunPowerShellScript =
	'# devenv:name=Dev Server (PowerShell complex deps)\n# devenv:mode=tmux\n# Shared infra: redis. Unique infra: mailpit.\n# devenv:requires=[{"app":"go-rest-postgres","runtime":"docker","profile":"default"},{"app":"event-worker","runtime":"systemshell","profile":"dev"},{"infra":"redis"},{"infra":"mailpit"}]\n$ErrorActionPreference = "Stop"\nSet-StrictMode -Version Latest\nbun run dev\nexit $LASTEXITCODE\n';
const bunRunShellScript =
	'#!/usr/bin/env sh\n# devenv:name=Dev Server (complex deps)\n# devenv:mode=tmux\n# Shared infra: redis and script-clock. Unique infra: mailpit.\n# App deps: go-rest-postgres via Docker default profile, event-worker via systemshell dev profile.\n# devenv:requires=[{"app":"go-rest-postgres","runtime":"docker","profile":"default"},{"app":"event-worker","runtime":"systemshell","profile":"dev"},{"infra":"redis"},{"infra":"script-clock"},{"infra":"mailpit"}]\nset -eu\nbun run dev\n';
const bunTestDockerfile =
	"FROM oven/bun:1\nWORKDIR /src\nCOPY package.json bun.lock ./\nCOPY server/package.json ./server/package.json\nCOPY client/package.json ./client/package.json\nCOPY shared/package.json ./shared/package.json\nRUN bun install --frozen-lockfile --ignore-scripts\nCOPY . .\nRUN bun test\n";
const bunTestPowerShellScript =
	'# devenv:name=Local Test (PowerShell)\n# devenv:mode=logged\n$ErrorActionPreference = "Stop"\nSet-StrictMode -Version Latest\nbun install --frozen-lockfile\nif ($LASTEXITCODE -ne 0) { bun install; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }\nbun test\nexit $LASTEXITCODE\n';
const bunTestShellScript =
	"#!/usr/bin/env sh\n# devenv:name=Local Test\n# devenv:mode=logged\nset -eu\nbun install --frozen-lockfile || bun install\nbun test\n";
const eventWorkerCompose =
	'x-devenv:\n  requires: [{"infra":"postgres"},{"infra":"redis"}]\nservices:\n  event-worker:\n    image: oven/bun:1\n    command: sh -c "echo event-worker docker profile running && sleep infinity"\n    environment:\n      DATABASE_URL: postgres://postgres:postgres@postgres:5432/example?sslmode=disable\n      REDIS_URL: redis://redis:6379\n';
const eventWorkerRunPowerShellScript =
	'# devenv:name=Event Worker (PowerShell)\n# devenv:mode=tmux\n# Windows drift example: worker needs postgres and redis, but not script-clock.\n# devenv:requires=[{"infra":"postgres"},{"infra":"redis"}]\n$ErrorActionPreference = "Stop"\nSet-StrictMode -Version Latest\nWrite-Host "Event worker consuming jobs with Redis and Postgres"\nwhile ($true) { Start-Sleep -Seconds 10 }\n';
const eventWorkerRunShellScript =
	'#!/usr/bin/env sh\n# devenv:name=Event Worker (system shell)\n# devenv:mode=tmux\n# Shared infra with bhvr-site: redis and script-clock. Shared Docker infra with go-rest-postgres: postgres.\n# devenv:requires=[{"infra":"postgres"},{"infra":"redis"},{"infra":"script-clock"}]\nset -eu\necho "Event worker consuming jobs with Redis and Postgres"\nwhile true; do sleep 10; done\n';
const goBuildDockerfile =
	'FROM golang:1.25-alpine AS build\nWORKDIR /src\nCOPY go.mod go.sum ./\nRUN go mod download\nCOPY . .\nRUN go build -o /out/go-rest-postgres .\n\nFROM alpine:3.22\nLABEL devenv.artifacts="/out"\nCOPY --from=build /out /out\nCMD ["/out/go-rest-postgres"]\n';
const goCompose =
	'x-devenv:\n  requires: [{"infra":"postgres"},{"infra":"script-clock"}]\nservices:\n  go-rest-postgres:\n    image: devenv-go-rest-postgres:latest\n    environment:\n      DATABASE_URL: postgres://postgres:postgres@postgres:5432/example?sslmode=disable\n    ports: ["8080:8080"]\n    networks: [example]\nnetworks:\n  example:\n    name: devenv-example\n    external: true\n';
const goTestDockerfile =
	"FROM golang:1.25-alpine\nWORKDIR /src\nCOPY go.mod go.sum ./\nRUN go mod download\nCOPY . .\nRUN go test ./...\n";
const helloPowerShellScript =
	'#!/usr/bin/env pwsh\nif ($args -contains "--devenv-metadata") {\n  @\'\n[\n  {"name":"name","type":"string","required":true,"description":"Name to greet","defaultValue":"DevEnv","flag":"--name"},\n  {"name":"environment","type":"enum","required":true,"description":"Target environment","defaultValue":"dev","choices":["dev","test","prod"],"flag":"--env"},\n  {"name":"excited","type":"bool","required":false,"description":"Add extra enthusiasm","flag":"--excited"}\n]\n\'@ | Write-Output\n  exit 0\n}\n\n$name = "DevEnv"\n$environment = "dev"\n$excited = $false\nfor ($i = 0; $i -lt $args.Count; $i++) {\n  switch ($args[$i]) {\n    "--name" { if ($i + 1 -lt $args.Count) { $name = $args[++$i] } }\n    "--env" { if ($i + 1 -lt $args.Count) { $environment = $args[++$i] } }\n    "--excited" { $excited = $true }\n  }\n}\n\n$suffix = if ($excited) { "!" } else { "." }\nWrite-Output "Hello $name from $environment$suffix"\n';
const helloPythonScript =
	'#!/usr/bin/env python3\nimport argparse\nimport json\nimport sys\n\nif "--devenv-metadata" in sys.argv:\n    print(json.dumps([\n        {"name":"count","type":"int","required":true,"description":"How many greetings to print","defaultValue":"3","flag":"--count"},\n        {"name":"style","type":"enum","required":false,"description":"Greeting style","defaultValue":"friendly","choices":["friendly","formal"],"flag":"--style"},\n    ]))\n    raise SystemExit(0)\n\nparser = argparse.ArgumentParser()\nparser.add_argument("--count", type=int, default=3)\nparser.add_argument("--style", choices=["friendly", "formal"], default="friendly")\nargs = parser.parse_args()\nmessage = "Hello from DevEnv Python" if args.style == "friendly" else "Greetings from DevEnv Python"\nfor _ in range(args.count):\n    print(message)\n';
// biome-ignore lint/suspicious/noTemplateCurlyInString: the template body is generated content, not a substitution
const helloShellScript =
	'#!/usr/bin/env bash\nset -euo pipefail\n\nif [[ "${1:-}" == "--devenv-metadata" ]]; then\n  cat <<\'JSON\'\n[\n  {"name":"name","type":"string","required":true,"description":"Name to greet","defaultValue":"DevEnv","flag":"--name"},\n  {"name":"environment","type":"enum","required":true,"description":"Target environment","defaultValue":"dev","choices":["dev","test","prod"],"flag":"--env"},\n  {"name":"excited","type":"bool","required":false,"description":"Add extra enthusiasm","flag":"--excited"}\n]\nJSON\n  exit 0\nfi\n\nname="DevEnv"\nenvironment="dev"\nexcited=false\nwhile [[ $# -gt 0 ]]; do\n  case "$1" in\n    --name) name="${2:-DevEnv}"; shift 2 ;;\n    --env) environment="${2:-dev}"; shift 2 ;;\n    --excited) excited=true; shift ;;\n    *) shift ;;\n  esac\ndone\n\nsuffix="."\nif [[ "$excited" == true ]]; then suffix="!"; fi\necho "Hello ${name} from ${environment}${suffix}"\n';
const helloTypescriptScript =
	'#!/usr/bin/env bun\nif (process.argv.includes("--devenv-metadata")) {\n  console.log(JSON.stringify([\n    { name: "service", type: "enum", required: true, description: "Service to inspect", defaultValue: "api", choices: ["api", "worker", "db"], flag: "--service" },\n    { name: "verbose", type: "bool", required: false, description: "Print extra details", flag: "--verbose" },\n  ]));\n  process.exit(0);\n}\n\nconst args = process.argv.slice(2);\nconst value = (flag: string, fallback: string) => {\n  const idx = args.indexOf(flag);\n  return idx >= 0 ? args[idx + 1] ?? fallback : fallback;\n};\nconst service = value("--service", "api");\nconst verbose = args.includes("--verbose");\nconsole.log("Checking " + service);\nif (verbose) console.log("Verbose mode enabled");\n';
const mailpitCompose =
	'services:\n  mailpit:\n    image: axllent/mailpit:latest\n    ports: ["8025:8025", "1025:1025"]\n';
const postgresCompose =
	'services:\n  postgres:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_PASSWORD: postgres\n      POSTGRES_DB: example\n    ports: ["5432:5432"]\n    networks: [example]\nnetworks:\n  example:\n    name: devenv-example\n';
const postgresKubernetesChart =
	"apiVersion: v2\nname: devenv-postgres\nversion: 0.1.0\ntype: application\n";
const postgresKubernetesDeployment =
	'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: postgres\n  labels:\n    app.kubernetes.io/name: postgres\n    app.kubernetes.io/instance: {{ .Release.Name }}\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app.kubernetes.io/name: postgres\n      app.kubernetes.io/instance: {{ .Release.Name }}\n  template:\n    metadata:\n      labels:\n        app.kubernetes.io/name: postgres\n        app.kubernetes.io/instance: {{ .Release.Name }}\n    spec:\n      containers:\n        - name: postgres\n          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"\n          ports:\n            - name: postgres\n              containerPort: {{ .Values.service.port }}\n          env:\n            - name: POSTGRES_USER\n              value: {{ .Values.env.POSTGRES_USER | quote }}\n            - name: POSTGRES_PASSWORD\n              value: {{ .Values.env.POSTGRES_PASSWORD | quote }}\n            - name: POSTGRES_DB\n              value: {{ .Values.env.POSTGRES_DB | quote }}\n';
const postgresKubernetesService =
	"apiVersion: v1\nkind: Service\nmetadata:\n  name: postgres\n  labels:\n    app.kubernetes.io/name: postgres\n    app.kubernetes.io/instance: {{ .Release.Name }}\nspec:\n  selector:\n    app.kubernetes.io/name: postgres\n    app.kubernetes.io/instance: {{ .Release.Name }}\n  ports:\n    - name: postgres\n      port: {{ .Values.service.port }}\n      targetPort: postgres\n";
const postgresKubernetesValues =
	'image:\n  repository: postgres\n  tag: "16-alpine"\nservice:\n  port: 5432\nenv:\n  POSTGRES_USER: devenv\n  POSTGRES_PASSWORD: devenv\n  POSTGRES_DB: devenv\n';
const redisCompose =
	'services:\n  redis:\n    image: redis:7-alpine\n    ports: ["6379:6379"]\n';
const runtimeCheckDockerScript =
	'#!/usr/bin/env sh\n# devenv:name=Check Docker, Kubernetes, and PowerShell dependencies\n# devenv:mode=logged\n# devenv:requires=[{"infra":"runtime-check-powershell","runtime":"powershell","profile":"default","lifecycle":"shared"},{"infra":"postgres","runtime":"docker","profile":"default","provider":"docker","lifecycle":"shared"},{"infra":"runtime-check-k8s-docker","runtime":"kubernetes","profile":"local","provider":"docker","lifecycle":"shared"}]\nset -eu\n\nfail() { printf \'Dependency check failed: %s\\n\' "$1" >&2; exit 1; }\npgrep -f \'runtime-check-powershell.ps1\' >/dev/null || fail \'PowerShell dependency is not running\'\ndocker inspect --format \'{{.State.Running}}\' example-postgres 2>/dev/null | grep -qx true || fail \'Docker Postgres is not running\'\nkubectl --context kind-runtime-check-docker --namespace runtime-check-docker wait --for=condition=ready pod -l app.kubernetes.io/instance=runtime-check-postgres-docker --timeout=5s >/dev/null || fail \'Docker Kubernetes dependency is not ready\'\nprintf \'\\n  ____  _   _  ____ ____ _____ ____ ____\\n / ___|| | | |/ ___/ ___| ____/ ___/ ___|\\n \\\\___ \\\\| | | | |  | |   |  _| \\\\___ \\\\___ \\\\\\n  ___) | |_| | |__| |___| |___ ___) |__) |\\n |____/ \\\\___/ \\\\____\\\\____|_____|____/____/\\n\\n Docker + Kubernetes + PowerShell dependencies are ready.\\n\'\n';
const runtimeCheckKubernetesDockerDefinition =
	'{"ident":"runtime-check-k8s-docker","displayName":"Runtime Check Kubernetes (Docker)","type":"kubernetes","kubernetes":{"profile":"local","provider":"docker","cluster":"runtime-check-docker","context":"kind-runtime-check-docker","chartPath":"$CONFIG/infrastructure/k8s/postgres","release":"runtime-check-postgres-docker","namespace":"runtime-check-docker","values":["$CONFIG/infrastructure/k8s/postgres/values.yaml"],"wait":true,"timeout":"5m"}}\n';
const runtimeCheckKubernetesPodmanDefinition =
	'{"ident":"runtime-check-k8s-podman","displayName":"Runtime Check Kubernetes (Podman)","type":"kubernetes","kubernetes":{"profile":"local","provider":"podman","cluster":"runtime-check-podman","context":"kind-runtime-check-podman","chartPath":"$CONFIG/infrastructure/k8s/postgres","release":"runtime-check-postgres-podman","namespace":"runtime-check-podman","values":["$CONFIG/infrastructure/k8s/postgres/values.yaml"],"wait":true,"timeout":"5m"}}\n';
const runtimeCheckPodmanScript =
	'#!/usr/bin/env sh\n# devenv:name=Check Podman, Kubernetes, and shell dependencies\n# devenv:mode=logged\n# devenv:requires=[{"infra":"script-clock","runtime":"shell","profile":"default","lifecycle":"shared"},{"infra":"redis","runtime":"docker","profile":"default","provider":"podman","lifecycle":"shared"},{"infra":"runtime-check-k8s-podman","runtime":"kubernetes","profile":"local","provider":"podman","lifecycle":"shared"}]\nset -eu\n\nfail() { printf \'Dependency check failed: %s\\n\' "$1" >&2; exit 1; }\npgrep -f \'script-clock.sh\' >/dev/null || fail \'Shell dependency is not running\'\npodman inspect --format \'{{.State.Running}}\' example-redis 2>/dev/null | grep -qx true || fail \'Podman Redis is not running\'\nkubectl --context kind-runtime-check-podman --namespace runtime-check-podman wait --for=condition=ready pod -l app.kubernetes.io/instance=runtime-check-postgres-podman --timeout=5s >/dev/null || fail \'Podman Kubernetes dependency is not ready\'\nprintf \'\\n  ____  _   _  ____ ____ _____ ____ ____\\n / ___|| | | |/ ___/ ___| ____/ ___/ ___|\\n \\\\___ \\\\| | | | |  | |   |  _| \\\\___ \\\\___ \\\\\\n  ___) | |_| | |__| |___| |___ ___) |__) |\\n |____/ \\\\___/ \\\\____\\\\____|_____|____/____/\\n\\n Podman + Kubernetes + shell dependencies are ready.\\n\'\n';
const runtimeCheckPowerShellDefinition =
	'{"ident":"runtime-check-powershell","displayName":"Runtime Check PowerShell","type":"script","powerShellPath":"$CONFIG/infrastructure/scripts/runtime-check-powershell.ps1","defaultRunner":"powershell","cwd":"$CONFIG"}\n';
const runtimeCheckPowerShellScript =
	'$ErrorActionPreference = "Stop"\nSet-StrictMode -Version Latest\nWrite-Output "Runtime Check PowerShell dependency started"\nwhile ($true) { Start-Sleep -Seconds 60 }\n';
const runtimeDependencyCheckAppDefinition =
	'{"ident":"runtime-dependency-check","displayName":"Runtime Dependency Check","repositoryPath":"https://github.com/friendsfriend/devenv.git","containerBaseName":"runtime-dependency-check","sourceType":"git","gitMode":"BRANCH"}\n';
// biome-ignore lint/suspicious/noTemplateCurlyInString: the template body is generated content, not a substitution
const scriptClockShellScript =
	'#!/usr/bin/env sh\nset -eu\ninterval="2"\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    --interval) interval="${2:-2}"; shift 2 ;;\n    *) shift ;;\n  esac\ndone\necho "Script Clock starting (DEVENV_EXAMPLE=${DEVENV_EXAMPLE:-false})"\nwhile true; do\n  date \'+script-clock %Y-%m-%dT%H:%M:%S%z\'\n  sleep "$interval"\ndone\n';

/** Every file the generator writes, with its content. */
export function exampleConfigFiles(
	options: ExampleConfigOptions,
): Array<[string, string]> {
	const configDir = options.configDir;
	const homeDir = options.homeDir;
	const scriptsDir = path.join(homeDir, "scripts");
	return [
		[path.join(configDir, ".env"), `DEVENV_HOME=${homeDir}\n`],
		[
			path.join(configDir, "apps", "definitions", "go-rest-postgres.json"),
			'{"ident":"go-rest-postgres","displayName":"Go REST Postgres","repositoryPath":"https://github.com/pauljamescleary/go-rest-postgres.git","containerBaseName":"go-rest-postgres","sourceType":"git","gitMode":"BRANCH"}' +
				"\n",
		],
		[
			path.join(configDir, "apps", "definitions", "bhvr-site.json"),
			'{"ident":"bhvr-site","displayName":"Bun TypeScript App","repositoryPath":"https://github.com/stevedylandev/bhvr-site.git","containerBaseName":"bhvr-site","sourceType":"git","gitMode":"BRANCH"}' +
				"\n",
		],
		[
			path.join(configDir, "apps", "definitions", "event-worker.json"),
			'{"ident":"event-worker","displayName":"Event Worker","repositoryPath":"https://github.com/wobsoriano/bun-lib-starter.git","containerBaseName":"event-worker","sourceType":"git","gitMode":"BRANCH"}' +
				"\n",
		],
		[
			path.join(
				configDir,
				"apps",
				"definitions",
				"runtime-dependency-check.json",
			),
			runtimeDependencyCheckAppDefinition,
		],
		[
			path.join(configDir, "libraries", "definitions", "bun-lib-starter.json"),
			'{"ident":"bun-lib-starter","displayName":"Bun Library Starter","repositoryPath":"https://github.com/wobsoriano/bun-lib-starter.git","containerBaseName":"bun-lib-starter","sourceType":"git","gitMode":"BRANCH"}' +
				"\n",
		],
		[
			path.join(configDir, "infrastructure", "definitions", "postgres.json"),
			'{"ident":"postgres","displayName":"Postgres","containerBaseName":"example-postgres"}' +
				"\n",
		],
		[
			path.join(configDir, "infrastructure", "definitions", "redis.json"),
			'{"ident":"redis","displayName":"Redis","containerBaseName":"example-redis"}' +
				"\n",
		],
		[
			path.join(configDir, "infrastructure", "definitions", "mailpit.json"),
			'{"ident":"mailpit","displayName":"Mailpit","containerBaseName":"example-mailpit"}' +
				"\n",
		],
		[
			path.join(
				configDir,
				"infrastructure",
				"definitions",
				"script-clock.json",
			),
			'{"ident":"script-clock","displayName":"Script Clock","type":"script","shellPath":"' +
				path.join(configDir, "infrastructure", "scripts", "script-clock.sh") +
				'","cwd":"' +
				configDir +
				'","args":["--interval","2"],"env":{"DEVENV_EXAMPLE":"true"}}' +
				"\n",
		],
		[
			path.join(
				configDir,
				"infrastructure",
				"definitions",
				"runtime-check-powershell.json",
			),
			runtimeCheckPowerShellDefinition,
		],
		[
			path.join(
				configDir,
				"infrastructure",
				"definitions",
				"runtime-check-k8s-docker.json",
			),
			runtimeCheckKubernetesDockerDefinition,
		],
		[
			path.join(
				configDir,
				"infrastructure",
				"definitions",
				"runtime-check-k8s-podman.json",
			),
			runtimeCheckKubernetesPodmanDefinition,
		],
		[
			path.join(
				configDir,
				"infrastructure",
				"definitions",
				"postgres-k8s.json",
			),
			'{"ident":"postgres-k8s","displayName":"Postgres (Kubernetes)","type":"kubernetes","kubernetes":{"profile":"local","chartPath":"' +
				path.join(configDir, "infrastructure", "k8s", "postgres") +
				'","release":"postgres-local","namespace":"infra","values":["' +
				path.join(
					configDir,
					"infrastructure",
					"k8s",
					"postgres",
					"values.yaml",
				) +
				'"],"wait":true,"timeout":"5m"}}' +
				"\n",
		],
		[
			path.join(configDir, "apps", "compose", "go-rest-postgres-compose.yml"),
			goCompose,
		],
		[
			path.join(configDir, "apps", "compose", "bhvr-site-compose.yml"),
			bunCompose,
		],
		[
			path.join(configDir, "apps", "compose", "bhvr-site-debug-compose.yml"),
			bunDebugCompose,
		],
		[
			path.join(
				configDir,
				"apps",
				"compose",
				"bhvr-site-with-redis-compose.yml",
			),
			bunRedisCompose,
		],
		[
			path.join(configDir, "apps", "compose", "event-worker-compose.yml"),
			eventWorkerCompose,
		],
		[
			path.join(configDir, "infrastructure", "compose", "postgres-compose.yml"),
			postgresCompose,
		],
		[
			path.join(configDir, "infrastructure", "compose", "redis-compose.yml"),
			redisCompose,
		],
		[
			path.join(configDir, "infrastructure", "compose", "mailpit-compose.yml"),
			mailpitCompose,
		],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the template body is generated content, not a substitution
		[
			path.join(configDir, "infrastructure", "scripts", "script-clock.sh"),
			scriptClockShellScript,
		],
		[
			path.join(
				configDir,
				"infrastructure",
				"scripts",
				"runtime-check-powershell.ps1",
			),
			runtimeCheckPowerShellScript,
		],
		[
			path.join(configDir, "apps", "k8s", "bhvr-site", "devenv.k8s.json"),
			bunKubernetesConfig,
		],
		[
			path.join(configDir, "apps", "k8s", "bhvr-site", "values.yaml"),
			bunKubernetesValues,
		],
		[
			path.join(configDir, "apps", "k8s", "bhvr-site", "chart", "Chart.yaml"),
			bunKubernetesChart,
		],
		[
			path.join(configDir, "apps", "k8s", "bhvr-site", "chart", "values.yaml"),
			bunKubernetesValues,
		],
		[
			path.join(
				configDir,
				"apps",
				"k8s",
				"bhvr-site",
				"chart",
				"templates",
				"deployment.yaml",
			),
			bunKubernetesDeployment,
		],
		[
			path.join(
				configDir,
				"apps",
				"k8s",
				"bhvr-site",
				"chart",
				"templates",
				"service.yaml",
			),
			bunKubernetesService,
		],
		[
			path.join(configDir, "infrastructure", "k8s", "postgres", "Chart.yaml"),
			postgresKubernetesChart,
		],
		[
			path.join(configDir, "infrastructure", "k8s", "postgres", "values.yaml"),
			postgresKubernetesValues,
		],
		[
			path.join(
				configDir,
				"infrastructure",
				"k8s",
				"postgres",
				"templates",
				"deployment.yaml",
			),
			postgresKubernetesDeployment,
		],
		[
			path.join(
				configDir,
				"infrastructure",
				"k8s",
				"postgres",
				"templates",
				"service.yaml",
			),
			postgresKubernetesService,
		],
		[
			path.join(
				configDir,
				"apps",
				"build",
				"go-rest-postgres-build.Dockerfile",
			),
			goBuildDockerfile,
		],
		[
			path.join(configDir, "apps", "build", "go-rest-postgres-test.Dockerfile"),
			goTestDockerfile,
		],
		[
			path.join(configDir, "apps", "build", "bhvr-site-build.Dockerfile"),
			bunBuildDockerfile,
		],
		[
			path.join(configDir, "apps", "build", "bhvr-site-test.Dockerfile"),
			bunTestDockerfile,
		],
		[
			path.join(configDir, "apps", "build", "bhvr-site-build.sh"),
			bunBuildShellScript,
		],
		[
			path.join(configDir, "apps", "build", "bhvr-site-test.sh"),
			bunTestShellScript,
		],
		[
			path.join(configDir, "apps", "build", "bhvr-site-build.ps1"),
			bunBuildPowerShellScript,
		],
		[
			path.join(configDir, "apps", "build", "bhvr-site-test.ps1"),
			bunTestPowerShellScript,
		],
		[
			path.join(configDir, "apps", "run", "bhvr-site-dev.sh"),
			bunRunShellScript,
		],
		[
			path.join(configDir, "apps", "run", "bhvr-site-dev.ps1"),
			bunRunPowerShellScript,
		],
		[
			path.join(configDir, "apps", "run", "event-worker-dev.sh"),
			eventWorkerRunShellScript,
		],
		[
			path.join(configDir, "apps", "run", "event-worker-dev.ps1"),
			eventWorkerRunPowerShellScript,
		],
		[
			path.join(
				configDir,
				"apps",
				"run",
				"runtime-dependency-check-docker-k8s-powershell.sh",
			),
			runtimeCheckDockerScript,
		],
		[
			path.join(
				configDir,
				"apps",
				"run",
				"runtime-dependency-check-podman-k8s-shell.sh",
			),
			runtimeCheckPodmanScript,
		],
		[
			path.join(configDir, "apps", "build", "bun-lib-starter-build.Dockerfile"),
			bunLibBuildDockerfile,
		],
		[
			path.join(configDir, "apps", "build", "bun-lib-starter-test.Dockerfile"),
			bunLibTestDockerfile,
		],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the template body is generated content, not a substitution
		[path.join(scriptsDir, "hello.sh"), helloShellScript],
		[path.join(scriptsDir, "hello.ps1"), helloPowerShellScript],
		[path.join(scriptsDir, "hello.py"), helloPythonScript],
		[path.join(scriptsDir, "hello.ts"), helloTypescriptScript],
	];
}

/** The config paths a generation run must never touch or overwrite. */
function ignoredConfigPath(target: string, root: string): boolean {
	for (const ignored of [
		path.join(root, ".env"),
		path.join(root, "providers"),
		path.join(root, "tui.json"),
	]) {
		if (target === ignored) return true;
	}
	return false;
}

/** Refuses a non-empty directory tree, ignoring the paths generation preserves. */
function ensureEmpty(dir: string, label: string, root: string): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		const target = path.join(dir, entry.name);
		if (ignoredConfigPath(target, root)) continue;
		if (!entry.isDirectory()) {
			throw new Error(
				`${label} ${JSON.stringify(dir)} is not empty; move existing files or choose a clean directory`,
			);
		}
		ensureEmpty(target, label, root);
	}
}

function writeFile(target: string, content: string, mode: number): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, { mode });
}

/** Whether a generated file is executable, as Go's mode rule decided. */
export function exampleConfigFileMode(
	target: string,
	options: ExampleConfigOptions,
): number {
	const scriptsDir = path.join(options.homeDir, "scripts");
	const appsDir = path.join(options.configDir, "apps");
	const infraScriptsDir = path.join(
		options.configDir,
		"infrastructure",
		"scripts",
	);
	const executable =
		path.dirname(target) === scriptsDir ||
		(path.extname(target) === ".sh" &&
			(path.dirname(path.dirname(target)) === appsDir ||
				path.dirname(target) === infraScriptsDir));
	return executable ? 0o755 : 0o644;
}

/**
 * Generates the example configuration tree. Both directories are checked before
 * the first write, so a refused run leaves the filesystem untouched.
 */
export function generateExampleConfig(options: ExampleConfigOptions): void {
	ensureEmpty(options.configDir, "config directory", options.configDir);
	const scriptsDir = path.join(options.homeDir, "scripts");
	ensureEmpty(scriptsDir, "scripts directory", scriptsDir);
	const envPath = path.join(options.configDir, ".env");
	for (const [target, content] of exampleConfigFiles(options)) {
		// An existing `.env` carries the user's runtime choice and is preserved.
		if (target === envPath && fs.existsSync(target)) continue;
		writeFile(target, content, exampleConfigFileMode(target, options));
	}
}
