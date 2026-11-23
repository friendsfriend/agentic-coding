import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createRuntimeExecutor,
	helmDeployments,
} from "../src/adapters/process/runtime-executor.ts";

test("application endpoint readiness requires an HTTP success response", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			return new URL(request.url).pathname === "/health"
				? new Response("ok")
				: new Response("missing", { status: 404 });
		},
	});
	const executor = createRuntimeExecutor();
	const probe = executor.probeEndpoints;
	if (!probe) throw new Error("Endpoint probe unavailable");
	try {
		expect(
			await probe({
				endpoints: [
					{ name: "app", url: `http://127.0.0.1:${server.port}/health` },
					{ name: "missing", url: `http://127.0.0.1:${server.port}/absent` },
				],
				signal: new AbortController().signal,
			}),
		).toEqual({ app: "ready", missing: "unreachable" });
	} finally {
		await server.stop(true);
	}
});

test("process handles observe readiness text and stop the process group", async () => {
	const executor = createRuntimeExecutor();
	const start = executor.processStart;
	if (!start) throw new Error("Process runtime unavailable");
	const handle = await start({
		executable: {
			kind: "process",
			program: "/bin/sh",
			args: ["-lc", "printf ready; exec sleep 30"],
			env: {},
			envRefs: {},
			readyText: "ready",
			timeoutSec: 5,
		},
		cwd: "/tmp",
		env: {},
		signal: new AbortController().signal,
	});
	expect(await handle.ready(new AbortController().signal)).toBe(true);
	expect(handle.output()).toContain("ready");
	expect(handle.pid).toBeGreaterThan(0);
	expect(await handle.stop()).toBe(true);
	expect(handle.exited()).toBe(true);
});

test("a controller crash makes the detached supervisor stop the process group", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "mcp-process-supervisor-"),
	);
	const appPidFile = path.join(root, "app.pid");
	const supervisorPidFile = path.join(root, "supervisor.pid");
	const script = path.join(root, "controller.ts");
	const runtime = new URL(
		"../src/adapters/process/runtime-executor.ts",
		import.meta.url,
	).pathname;
	fs.writeFileSync(
		script,
		`import fs from "node:fs";
import { createRuntimeExecutor } from ${JSON.stringify(runtime)};
const start = createRuntimeExecutor().processStart;
if (!start) throw new Error("missing process runtime");
const handle = await start({
  executable: {
    kind: "process",
    program: "/bin/sh",
    args: ["-lc", ${JSON.stringify(`echo $$ > ${appPidFile}; exec sleep 30`)}],
    env: {}, envRefs: {}, timeoutSec: 5,
  },
  cwd: ${JSON.stringify(root)},
  env: {},
  signal: new AbortController().signal,
});
fs.writeFileSync(${JSON.stringify(supervisorPidFile)}, String(handle.pid));
process.exit(0);
`,
	);
	const child = Bun.spawn([process.execPath, script], {
		cwd: root,
		stdout: "ignore",
		stderr: "pipe",
	});
	const appPid = await waitForPid(appPidFile);
	const supervisorPid = await waitForPid(supervisorPidFile);
	try {
		expect(await child.exited).toBe(0);
		expect(await gone(appPid, 3_000)).toBe(true);
	} finally {
		try {
			process.kill(-supervisorPid, "SIGKILL");
		} catch {
			/* Already stopped by the supervisor. */
		}
		try {
			process.kill(appPid, "SIGKILL");
		} catch {
			/* Already stopped by the supervisor. */
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

async function waitForPid(file: string) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const pid = Number(fs.readFileSync(file, "utf8"));
			if (Number.isInteger(pid) && pid > 0) return pid;
		} catch {
			/* Retry until the fixture writes it. */
		}
		await Bun.sleep(25);
	}
	throw new Error("Fixture did not publish a PID");
}

async function gone(pid: number, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await Bun.sleep(50);
	}
	return false;
}

test("podman builds use the podman binary and --url prefix", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-podman-"));
	const argsFile = path.join(root, "args.txt");
	const podman = path.join(root, "podman");
	fs.writeFileSync(
		podman,
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nexit 0\n`,
		{ mode: 0o700 },
	);
	try {
		const result = await createRuntimeExecutor({ podman }).dockerBuild({
			executable: {
				kind: "docker-build",
				provider: "podman",
				socket: "/tmp/podman.sock",
				context: root,
				dockerfileSource: "FROM scratch\n",
				image: "example:podman",
				secrets: [],
				timeoutSec: 5,
			},
			cwd: root,
			secrets: {},
			redact: (value) => value,
			signal: new AbortController().signal,
		});
		expect(result.exitCode).toBe(0);
		const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
		expect(args.slice(0, 4)).toEqual([
			"--url",
			"unix:///tmp/podman.sock",
			"build",
			"-t",
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("podman compose uses podman-compose and the declared project", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-podman-compose-"));
	const argsFile = path.join(root, "args.txt");
	const podmanCompose = path.join(root, "podman-compose");
	fs.writeFileSync(
		podmanCompose,
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nexit 0\n`,
		{ mode: 0o700 },
	);
	try {
		const result = await createRuntimeExecutor({
			podmanCompose,
		}).composeUp({
			executable: {
				kind: "compose",
				provider: "podman",
				socket: "/tmp/podman.sock",
				source: "services:\n  api:\n    image: example:latest\n",
				project: "environment-mcp",
				services: ["api"],
				envRefs: {},
				serviceEnvRefs: {},
				timeoutSec: 5,
			},
			cwd: root,
			env: {},
			redact: (value) => value,
			signal: new AbortController().signal,
		});
		expect(result.exitCode).toBe(0);
		const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
		expect(args.slice(0, 5)).toEqual([
			"-p",
			"environment-mcp",
			"-f",
			expect.stringContaining("compose.yaml"),
			"up",
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("compose service environment is injected through a private override file", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-compose-override-"));
	const argsFile = path.join(root, "args.txt");
	const overrideFile = path.join(root, "override.txt");
	const docker = path.join(root, "docker");
	fs.writeFileSync(
		docker,
		`#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
previous=
for arg in "$@"; do
  if [ "$previous" = "-f" ] && [ "$arg" != "${root}/compose.yaml" ]; then
    cp "$arg" ${JSON.stringify(overrideFile)}
  fi
  previous="$arg"
done
exit 0
`,
		{ mode: 0o700 },
	);
	try {
		const result = await createRuntimeExecutor({ docker }).composeUp({
			executable: {
				kind: "compose",
				provider: "docker",
				socket: "/tmp/docker.sock",
				source: "services:\n  api:\n    image: example:latest\n",
				project: "environment-mcp",
				services: ["api"],
				envRefs: {},
				serviceEnvRefs: {},
				timeoutSec: 5,
			},
			cwd: root,
			env: {},
			serviceEnv: { api: { "API-TOKEN": "private-$value" } },
			redact: (value) => value,
			signal: new AbortController().signal,
		});
		expect(result.exitCode).toBe(0);
		const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
		expect(args.filter((arg) => arg === "-f")).toHaveLength(2);
		expect(JSON.parse(fs.readFileSync(overrideFile, "utf8"))).toEqual({
			services: {
				api: { environment: { "API-TOKEN": "private-$$value" } },
			},
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("container runs pass published ports and environment names without secret values", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-container-"));
	const argsFile = path.join(root, "args.txt");
	const docker = path.join(root, "docker");
	fs.writeFileSync(
		docker,
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nprintf '%064d\\n' 0 | tr '0' 'a'\nexit 0\n`,
		{ mode: 0o700 },
	);
	try {
		const result = await createRuntimeExecutor({ docker }).containerRun?.({
			executable: {
				kind: "container-run",
				provider: "docker",
				socket: "/tmp/docker.sock",
				image: "example:latest",
				name: "environment-mcp-test",
				ports: [{ host: 8075, container: 80, address: "127.0.0.1" }],
				env: { LITERAL: "public" },
				envRefs: { TOKEN: "TOKEN" },
				readiness: "running",
				telemetry: "otlp-http-json",
				timeoutSec: 5,
			},
			cwd: root,
			env: { TOKEN: "secret-value" },
			telemetry: { certificate: "/tmp/ca.pem" },
			redact: (value) => value,
			signal: new AbortController().signal,
		});
		if (!result) throw new Error("Container runtime unavailable");
		expect(result.containerId).toBe("a".repeat(64));
		const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
		expect(args).toContain("--name");
		expect(args).toContain("environment-mcp-test");
		expect(args).toContain("-p");
		expect(args).toContain("127.0.0.1:8075:80");
		expect(args).toContain("-e");
		expect(args).toContain("LITERAL");
		expect(args).toContain("TOKEN");
		expect(args).toContain("--add-host");
		expect(args).toContain("host.docker.internal:host-gateway");
		expect(args).toContain("/tmp/ca.pem:/environment-mcp-otel-ca.pem:ro");
		expect(args).not.toContain("secret-value");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("rendered Helm manifests identify only namespaced Deployments", () => {
	const manifest = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: default
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: default
`;
	expect(helmDeployments(manifest, "default")).toEqual(["api"]);
	expect(() =>
		helmDeployments(
			manifest.replace("namespace: default", "namespace: other"),
			"default",
		),
	).toThrow("another namespace");
	expect(() =>
		helmDeployments(
			`apiVersion: v1
kind: Namespace
metadata:
  name: escape
`,
			"default",
		),
	).toThrow("cluster-scoped");
	expect(() =>
		helmDeployments(
			`apiVersion: v1
kind: List
metadata:
  name: batch
items: []
`,
			"default",
		),
	).toThrow("cluster-scoped or list");
});

test("helm execution freezes the rendered deployment set and verifies cleanup identity", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-helm-"));
	const helmArgs = path.join(root, "helm-args.txt");
	const kubectlArgs = path.join(root, "kubectl-args.txt");
	const helm = path.join(root, "helm");
	const kubectl = path.join(root, "kubectl");
	const manifest = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: default
`;
	fs.writeFileSync(
		helm,
		`#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(helmArgs)}
while [ "$1" = "--kube-context" ] || [ "$1" = "--kubeconfig" ]; do
  shift 2
done
case "$1" in
  list) printf '[]\\n' ;;
  template) cat <<'YAML'
${manifest}YAML
    ;;
  install) printf '{"name":"fixture","namespace":"default","version":1,"info":{"status":"deployed"}}\\n' ;;
  get)
    if [ "$2" = "metadata" ]; then
      printf '{"name":"fixture","namespace":"default","revision":1,"status":"deployed","labels":{"environment-mcp-run":"run-label"}}\\n'
    else
      cat <<'YAML'
${manifest}YAML
    fi
    ;;
  uninstall) exit 0 ;;
  *) exit 2 ;;
esac
`,
		{ mode: 0o700 },
	);
	fs.writeFileSync(
		kubectl,
		`#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(kubectlArgs)}
cat <<'JSON'
{"items":[{"metadata":{"name":"api","namespace":"default","generation":1,"annotations":{"meta.helm.sh/release-name":"fixture","meta.helm.sh/release-namespace":"default"}},"status":{"observedGeneration":1,"conditions":[{"type":"Available","status":"True"}]}}]}
JSON
`,
		{ mode: 0o700 },
	);
	try {
		const executor = createRuntimeExecutor({ helm, kubectl });
		const executable = {
			kind: "helm-release" as const,
			cluster: "devenv",
			clusterDigest: "a".repeat(64),
			namespace: "default",
			release: "fixture",
			chart: root,
			chartDigest: "b".repeat(64),
			values: [],
			setString: {},
			timeoutSec: 10,
		};
		const cluster = {
			context: "kind-devenv",
			environment: { PATH: process.env.PATH ?? "/usr/bin" },
		};
		const result = await executor.helmInstall?.({
			executable,
			cluster,
			runLabel: "run-label",
			signal: new AbortController().signal,
			redact: (value) => value,
		});
		expect(result).toMatchObject({
			exitCode: 0,
			readiness: "ready",
			deployments: ["api"],
			created: {
				release: "fixture",
				namespace: "default",
				revision: 1,
				label: "run-label",
			},
		});
		const installArgs = fs.readFileSync(helmArgs, "utf8");
		expect(installArgs).toContain("template");
		expect(installArgs).toContain("install");
		expect(installArgs).toContain("environment-mcp-run=run-label");
		expect(installArgs).not.toContain("--all");
		expect(fs.readFileSync(kubectlArgs, "utf8")).toContain("deployment");
		expect(
			await executor.helmUninstall?.({
				executable,
				cluster,
				release: "fixture",
				namespace: "default",
				revision: 1,
				label: "run-label",
				signal: new AbortController().signal,
				redact: (value) => value,
			}),
		).toBe(true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("network-only execution creates, inspects, joins and removes the exact bridge", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-network-"));
	const argsFile = path.join(root, "args.txt");
	const removedFile = path.join(root, "removed");
	const docker = path.join(root, "docker");
	fs.writeFileSync(
		docker,
		`#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(argsFile)}
case "$2" in
  create) printf '%064d\\n' 0 | tr '0' 'a' ;;
  inspect)
    if [ -f ${JSON.stringify(removedFile)} ]; then exit 1; fi
    printf '{"Id":"%s","Name":"environment-mcp-network-api-abc","Labels":{"environment-mcp":"true","environment-mcp-app":"api","environment-mcp-target":"run"},"Containers":{}}\\n' "$(printf '%064d' 0 | tr '0' 'b')"
    ;;
  connect) exit 0 ;;
  rm) touch ${JSON.stringify(removedFile)}; exit 0 ;;
  *) exit 2 ;;
esac
`,
		{ mode: 0o700 },
	);
	try {
		const executor = createRuntimeExecutor({ docker });
		const executable = {
			kind: "network-only" as const,
			provider: "docker" as const,
			socket: "/tmp/docker.sock",
			network: "environment-mcp-network-api-abc",
			app: "api",
			target: "run",
			timeoutSec: 5,
		};
		const signal = new AbortController().signal;
		const created = await executor.networkCreate?.({
			executable,
			signal,
			redact: (value) => value,
		});
		expect(created).toMatchObject({ networkId: "a".repeat(64) });
		const inspected = await executor.networkInspect?.({
			socket: "/tmp/docker.sock",
			name: executable.network,
			signal,
		});
		expect(inspected).toMatchObject({
			id: "b".repeat(64),
			name: executable.network,
			labels: { "environment-mcp-app": "api" },
			containers: [],
		});
		expect(
			await executor.networkConnect?.({
				socket: "/tmp/docker.sock",
				networkId: inspected?.id ?? "",
				containers: ["c".repeat(64)],
				signal,
			}),
		).toEqual(["c".repeat(64)]);
		expect(
			await executor.networkRemove?.({
				socket: "/tmp/docker.sock",
				networkId: inspected?.id ?? "",
				name: executable.network,
				signal,
				redact: (value) => value,
			}),
		).toBe(true);
		const args = fs.readFileSync(argsFile, "utf8");
		expect(args).toContain("environment-mcp-app=api");
		expect(args).toContain("connect");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("network removal refuses a bridge that still has attached containers", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-network-attached-"));
	const argsFile = path.join(root, "args.txt");
	const removedFile = path.join(root, "removed");
	const docker = path.join(root, "docker");
	fs.writeFileSync(
		docker,
		`#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(argsFile)}
case "$2" in
  inspect) printf '{"Id":"%s","Name":"environment-mcp-network-api-abc","Containers":{"%s":{}}}\\n' "$(printf '%064d' 0 | tr '0' 'b')" "$(printf '%064d' 0 | tr '0' 'c')" ;;
  rm) touch ${JSON.stringify(removedFile)}; exit 0 ;;
  *) exit 2 ;;
esac
`,
		{ mode: 0o700 },
	);
	try {
		const removed = await createRuntimeExecutor({ docker }).networkRemove?.({
			socket: "/tmp/docker.sock",
			networkId: "b".repeat(64),
			name: "environment-mcp-network-api-abc",
			signal: new AbortController().signal,
			redact: (value) => value,
		});
		expect(removed).toBe(false);
		expect(fs.existsSync(removedFile)).toBe(false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("podman-compose ps does not pass service names unsupported by podman-compose", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-podman-ps-"));
	const argsFile = path.join(root, "args.txt");
	const podmanCompose = path.join(root, "podman-compose");
	fs.writeFileSync(
		podmanCompose,
		`#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
printf '%064d\\n' 0 | tr '0' 'a'
`,
		{ mode: 0o700 },
	);
	try {
		const ids = await createRuntimeExecutor({
			podmanCompose,
		}).composeContainers({
			executable: {
				kind: "compose",
				provider: "podman",
				socket: "/tmp/podman.sock",
				source: "services:\n  api:\n    image: example:latest\n",
				project: "environment-mcp",
				services: ["api"],
				envRefs: {},
				serviceEnvRefs: {},
				timeoutSec: 5,
			},
			cwd: root,
			env: {},
			signal: new AbortController().signal,
		});
		expect(ids).toEqual(["a".repeat(64)]);
		const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
		expect(args).toContain("ps");
		expect(args).toContain("-q");
		expect(args).not.toContain("api");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
