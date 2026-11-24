import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Executable, ExecutionPort } from "../../domain/execution.ts";

const outputLimit = 64 * 1024;
const inherited = ["PATH", "HOME", "LANG", "TMPDIR", "TERM", "TZ"] as const;
const clusterScopedHelmKinds = new Set([
	"Namespace",
	"Node",
	"PersistentVolume",
	"StorageClass",
	"PriorityClass",
	"RuntimeClass",
	"IngressClass",
	"GatewayClass",
	"ClusterRole",
	"ClusterRoleBinding",
	"CustomResourceDefinition",
	"APIService",
	"MutatingWebhookConfiguration",
	"ValidatingWebhookConfiguration",
	"ValidatingAdmissionPolicy",
	"ValidatingAdmissionPolicyBinding",
	"CSIDriver",
	"CSINode",
	"VolumeSnapshotClass",
	"ClusterIssuer",
	"ClusterSecretStore",
	"ClusterExternalSecret",
	"ClusterTriggerAuthentication",
]);
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** Rendered Helm manifest → the apps/v1 Deployments readiness may wait for.
 * Cross-namespace, cluster-scoped and list objects refuse before installation. */
export function helmDeployments(manifest: string, namespace: string) {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(manifest);
	} catch {
		throw new Error("Rendered Helm manifest is not valid YAML");
	}
	const documents = (Array.isArray(parsed) ? parsed : [parsed]).filter(
		(value) => value !== null && value !== undefined,
	);
	if (!documents.length || documents.length > 256)
		throw new Error("Rendered Helm manifest needs 1 to 256 objects");
	const deployments = new Set<string>();
	for (const raw of documents) {
		const document = object(raw);
		const metadata = object(document.metadata);
		if (
			typeof document.kind !== "string" ||
			typeof document.apiVersion !== "string" ||
			typeof metadata.name !== "string"
		)
			throw new Error("Rendered Helm object lacks kind/apiVersion/name");
		if (
			clusterScopedHelmKinds.has(document.kind) ||
			document.kind.endsWith("List")
		)
			throw new Error(
				"Rendered Helm manifest contains a cluster-scoped or list object",
			);
		if (
			metadata.namespace !== undefined &&
			metadata.namespace !== null &&
			metadata.namespace !== "" &&
			metadata.namespace !== namespace
		)
			throw new Error(
				"Rendered Helm object targets another namespace than the release",
			);
		if (document.kind === "Deployment" && document.apiVersion === "apps/v1")
			deployments.add(metadata.name);
	}
	if (!deployments.size)
		throw new Error(
			"Rendered Helm release has no apps/v1 Deployment to wait for",
		);
	return [...deployments].sort();
}

/** A detached supervisor owns the app's process group. If the controller dies
 * without a graceful stop, the supervisor kills the group instead of leaving an
 * orphan. The supervisor is not a cleanup authority after a controller restart;
 * the journal still never adopts a saved PID. */
const supervisorSource = `
const { spawn } = require("node:child_process");
const spec = JSON.parse(process.argv[1]);
const child = spawn(spec.file, spec.args, {
  cwd: spec.cwd,
  env: process.env,
  detached: false,
  stdio: ["ignore", "inherit", "inherit"],
});
const parent = process.ppid;
const timer = setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    try { process.kill(-process.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch {} }
    process.exit(0);
  }
}, 250);
child.on("exit", (code, signal) => {
  clearInterval(timer);
  process.exit(code ?? (signal ? 1 : 0));
});
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try { child.kill(sig); } catch {}
  });
}
`;

type RunResult = {
	exitCode: number | null;
	timedOut: boolean;
	output: string;
	truncated: boolean;
};

/** Fixed-argv process boundary: no shell interpolation, caller URL, model command
 * or arbitrary environment. Docker CLI use is limited to the declared project's
 * explicit services and exact container IDs already recorded as owned. */
export function createRuntimeExecutor(
	options: {
		docker?: string;
		podman?: string;
		podmanCompose?: string;
		helm?: string;
		kubectl?: string;
	} = {},
): ExecutionPort {
	const docker = options.docker ?? Bun.which("docker");
	const podman = options.podman ?? Bun.which("podman");
	const podmanCompose = options.podmanCompose ?? Bun.which("podman-compose");
	const helm = options.helm ?? Bun.which("helm");
	const kubectl = options.kubectl ?? Bun.which("kubectl");
	const run = async (
		program: string,
		args: string[],
		options: {
			cwd?: string;
			env: Record<string, string>;
			timeoutSec: number;
			signal: AbortSignal;
			redact: (value: string) => string;
			onOutput?: (chunk: string) => void;
		},
	): Promise<RunResult> => {
		const timeout = AbortSignal.timeout(options.timeoutSec * 1000);
		const signal = AbortSignal.any([options.signal, timeout]);
		const child = Bun.spawn([program, ...args], {
			cwd: options.cwd,
			env: {
				...Object.fromEntries(
					inherited.flatMap((key) =>
						process.env[key] ? [[key, process.env[key] as string]] : [],
					),
				),
				...options.env,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stop = () => {
			child.kill("SIGKILL");
		};
		signal.addEventListener("abort", stop, { once: true });
		let buffer = Buffer.alloc(0);
		let truncated = false;
		const collect = async (stream: ReadableStream<Uint8Array>) => {
			const decoder = new TextDecoder();
			for await (const chunk of stream) {
				buffer = Buffer.concat([buffer, chunk]);
				if (buffer.length > outputLimit) {
					buffer = buffer.subarray(buffer.length - outputLimit);
					truncated = true;
				}
				options.onOutput?.(decoder.decode(chunk, { stream: true }));
			}
			const tail = decoder.decode();
			if (tail) options.onOutput?.(tail);
		};
		try {
			await Promise.all([
				collect(child.stdout),
				collect(child.stderr),
				child.exited,
			]);
		} finally {
			signal.removeEventListener("abort", stop);
		}
		return {
			exitCode: child.exitCode,
			timedOut: timeout.aborted,
			output: options.redact(buffer.toString("utf8")),
			truncated,
		};
	};
	const startProcess = async ({
		executable,
		cwd,
		env,
		signal,
	}: {
		executable: Extract<Executable, { kind: "process" }>;
		cwd: string;
		env: Record<string, string>;
		signal: AbortSignal;
	}) => {
		signal.throwIfAborted();
		const child = spawn(
			process.execPath,
			[
				"-e",
				supervisorSource,
				JSON.stringify({
					file: executable.program,
					args: executable.args,
					cwd,
				}),
			],
			{
				cwd,
				env: {
					...Object.fromEntries(
						inherited.flatMap((key) =>
							process.env[key] ? [[key, process.env[key] as string]] : [],
						),
					),
					...env,
				},
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		if (!child.pid) throw new Error("process-start-unavailable");
		const pid = child.pid;
		let output = "";
		const capture = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > 64 * 1024)
				output = output.slice(output.length - 64 * 1024);
		};
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		let hasExited = false;
		const exited = new Promise<void>((resolve) =>
			child.once("exit", () => {
				hasExited = true;
				resolve();
			}),
		);
		const timed = (ms: number) =>
			Promise.race([
				exited,
				new Promise<void>((resolve) => setTimeout(resolve, ms)),
			]);
		return {
			pid,
			output: () => output,
			exited: () => hasExited,
			exitCode: () => child.exitCode,
			async ready(readySignal: AbortSignal) {
				const deadline = Date.now() + executable.timeoutSec * 1000;
				if (!executable.readyText && !executable.readyUrl) {
					if (hasExited) return false;
					return true;
				}
				for (;;) {
					readySignal.throwIfAborted();
					if (hasExited) return false;
					if (executable.readyText && output.includes(executable.readyText))
						return true;
					if (executable.readyUrl) {
						const timeout = new AbortController();
						const timer = setTimeout(() => timeout.abort(), 1000);
						try {
							const response = await fetch(executable.readyUrl, {
								method: "GET",
								redirect: "manual",
								signal: AbortSignal.any([readySignal, timeout.signal]),
							});
							await response.body?.cancel();
							if (response.status >= 200 && response.status < 400) return true;
						} catch {
							readySignal.throwIfAborted();
						} finally {
							clearTimeout(timer);
						}
					}
					if (Date.now() >= deadline) return false;
					await Bun.sleep(100);
				}
			},
			async stop() {
				if (hasExited) return true;
				try {
					process.kill(-pid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
				await timed(5000);
				if (!hasExited) {
					try {
						process.kill(-pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
					await timed(2000);
				}
				return hasExited;
			},
		};
	};
	const engine = (provider: "docker" | "podman") =>
		provider === "podman" ? podman : docker;
	const engineEnv = (
		provider: "docker" | "podman",
		socket: string,
	): Record<string, string> =>
		provider === "podman"
			? {
					DOCKER_HOST: `unix://${socket}`,
					CONTAINER_HOST: `unix://${socket}`,
				}
			: { DOCKER_HOST: `unix://${socket}` };
	const enginePrefix = (provider: "docker" | "podman", socket: string) =>
		provider === "podman" ? ["--url", `unix://${socket}`] : [];
	const helmClusterArgs = (cluster: {
		context: string;
		kubeconfig?: string;
	}) => [
		"--kube-context",
		cluster.context,
		...(cluster.kubeconfig ? ["--kubeconfig", cluster.kubeconfig] : []),
	];
	const kubectlClusterArgs = (cluster: {
		context: string;
		kubeconfig?: string;
	}) => [
		"--context",
		cluster.context,
		...(cluster.kubeconfig ? ["--kubeconfig", cluster.kubeconfig] : []),
	];
	const composeProgram = (provider: "docker" | "podman") =>
		provider === "podman" ? podmanCompose : docker;
	const composeArgs = (
		provider: "docker" | "podman",
		files: readonly string[],
		project: string,
		args: string[],
	) => {
		const selected = files.flatMap((file) => ["-f", file]);
		return provider === "podman"
			? ["-p", project, ...selected, ...args]
			: ["compose", "-p", project, ...selected, ...args];
	};
	const withComposeFiles = async <T>(
		executable: Extract<Executable, { kind: "compose" }>,
		serviceEnv: Record<string, Record<string, string>> | undefined,
		serviceMounts:
			| Record<string, { source: string; target: string }[]>
			| undefined,
		action: (files: string[]) => Promise<T>,
	) => {
		const temp = fs.mkdtempSync(
			path.join(os.tmpdir(), "environment-mcp-compose-"),
		);
		fs.chmodSync(temp, 0o700);
		try {
			const files: string[] = [];
			if (executable.file) files.push(executable.file);
			else {
				const file = path.join(temp, "compose.yaml");
				fs.writeFileSync(file, executable.source ?? "", { mode: 0o600 });
				files.push(file);
			}
			const services = new Set([
				...Object.keys(serviceEnv ?? {}),
				...Object.keys(serviceMounts ?? {}),
			]);
			if (services.size) {
				const selected: Record<
					string,
					{
						environment?: Record<string, string>;
						volumes?: {
							type: "bind";
							source: string;
							target: string;
							read_only: true;
						}[];
					}
				> = {};
				for (const service of services) {
					if (!executable.services.includes(service))
						throw new Error("compose-service-override-unavailable");
					const environment = Object.fromEntries(
						Object.entries(serviceEnv?.[service] ?? {}).map(([key, value]) => [
							key,
							value.replaceAll("$", () => "$$"),
						]),
					);
					const mounts = serviceMounts?.[service] ?? [];
					if (!Object.keys(environment).length && !mounts.length) continue;
					for (const mount of mounts)
						if (
							!mount.source.startsWith("/") ||
							!mount.target.startsWith("/") ||
							/[\0\r\n]/.test(mount.source) ||
							/[\0\r\n]/.test(mount.target)
						)
							throw new Error("compose-mount-unavailable");
					selected[service] = {
						...(Object.keys(environment).length ? { environment } : {}),
						...(mounts.length
							? {
									volumes: mounts.map((mount) => ({
										type: "bind" as const,
										source: mount.source,
										target: mount.target,
										read_only: true as const,
									})),
								}
							: {}),
					};
				}
				if (Object.keys(selected).length) {
					const override = path.join(temp, "override.yaml");
					fs.writeFileSync(override, JSON.stringify({ services: selected }), {
						mode: 0o600,
					});
					files.push(override);
				}
			}
			return await action(files);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	};
	const inspect = async (
		provider: "docker" | "podman",
		socket: string,
		ids: string[],
		signal: AbortSignal,
	) => {
		const command = engine(provider);
		if (!command) throw new Error(`${provider}-unavailable`);
		const result = await run(
			command,
			[
				...enginePrefix(provider, socket),
				"inspect",
				"--format",
				"{{.State.Running}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
				...ids,
			],
			{
				env: engineEnv(provider, socket),
				timeoutSec: 15,
				signal,
				redact: (value) => value,
			},
		);
		if (result.exitCode !== 0) throw new Error("inspect-unavailable");
		return result.output.trim().split("\n");
	};
	return {
		processStart: startProcess,
		containerRun: async ({
			executable,
			cwd,
			env,
			telemetry,
			signal,
			redact,
		}) => {
			const provider = executable.provider ?? "docker";
			const command = engine(provider);
			if (!command)
				return {
					containerId: null,
					timedOut: false,
					output: `${provider}-unavailable`,
					truncated: false,
				};
			if (Object.keys(executable.env).some((key) => Object.hasOwn(env, key)))
				throw new Error("container-environment-conflict");
			const values = { ...executable.env, ...env };
			const args = [
				...enginePrefix(provider, executable.socket),
				"run",
				"-d",
				"--name",
				executable.name,
			];
			for (const port of executable.ports)
				args.push(
					"-p",
					`${port.address === "::1" ? "[::1]" : port.address}:${port.host}:${port.container}`,
				);
			if (telemetry) {
				if (
					!telemetry.certificate.startsWith("/") ||
					/[\0\r\n,]/.test(telemetry.certificate)
				)
					throw new Error("container-telemetry-mount-unavailable");
				args.push(
					"--add-host",
					"host.docker.internal:host-gateway",
					"-v",
					`${telemetry.certificate}:/environment-mcp-otel-ca.pem:ro`,
				);
			}
			for (const key of Object.keys(values)) args.push("-e", key);
			args.push(executable.image);
			const result = await run(command, args, {
				cwd,
				env: { ...engineEnv(provider, executable.socket), ...values },
				timeoutSec: executable.timeoutSec,
				signal,
				redact,
			});
			const containerId =
				result.output
					.split("\n")
					.map((line) => line.trim())
					.find((line) => /^[a-f0-9]{12,64}$/.test(line)) ?? null;
			return {
				containerId: result.exitCode === 0 ? containerId : null,
				timedOut: result.timedOut,
				output: result.output,
				truncated: result.truncated,
			};
		},
		command: ({ executable, cwd, env, redact, onOutput, signal }) =>
			run(executable.program, executable.args, {
				cwd,
				env,
				timeoutSec: executable.timeoutSec,
				signal,
				redact,
				onOutput,
			}),
		dockerBuild: async ({
			executable,
			cwd,
			secrets,
			redact,
			onOutput,
			signal,
		}) => {
			const provider = executable.provider ?? "docker";
			const command = engine(provider);
			if (!command)
				return {
					exitCode: null,
					timedOut: false,
					output: `${provider}-unavailable`,
					truncated: false,
				};
			const temp = fs.mkdtempSync(
				path.join(os.tmpdir(), "environment-mcp-build-"),
			);
			try {
				fs.chmodSync(temp, 0o700);
				const args = [
					...enginePrefix(provider, executable.socket),
					"build",
					"-t",
					executable.image,
				];
				if (executable.dockerfileSource) {
					const file = path.join(temp, "Dockerfile");
					fs.writeFileSync(file, executable.dockerfileSource, { mode: 0o600 });
					args.push("-f", file);
				} else if (executable.dockerfile)
					args.push("-f", executable.dockerfile);
				for (const secret of executable.secrets) {
					const file = path.join(temp, `secret-${secret.id}`);
					fs.writeFileSync(file, secrets[secret.id] ?? "", { mode: 0o600 });
					args.push("--secret", `id=${secret.id},src=${file}`);
				}
				args.push(executable.context);
				return await run(command, args, {
					cwd,
					env: {
						...engineEnv(provider, executable.socket),
						DOCKER_BUILDKIT: "1",
					},
					timeoutSec: executable.timeoutSec,
					signal,
					redact,
					onOutput,
				});
			} finally {
				fs.rmSync(temp, { recursive: true, force: true });
			}
		},
		composeUp: ({
			executable,
			cwd,
			env,
			serviceEnv,
			serviceMounts,
			redact,
			signal,
		}) => {
			const provider = executable.provider ?? "docker";
			const command = composeProgram(provider);
			if (!command)
				return Promise.resolve({
					exitCode: null,
					timedOut: false,
					output: `${provider}-unavailable`,
					truncated: false,
				});
			return withComposeFiles(executable, serviceEnv, serviceMounts, (files) =>
				run(
					command,
					composeArgs(provider, files, executable.project, [
						"up",
						"-d",
						...executable.services,
					]),
					{
						cwd,
						env: { ...engineEnv(provider, executable.socket), ...env },
						timeoutSec: executable.timeoutSec,
						signal,
						redact,
					},
				),
			);
		},
		composeContainers: async ({ executable, cwd, env, signal }) => {
			const provider = executable.provider ?? "docker";
			const command = composeProgram(provider);
			if (!command) throw new Error(`${provider}-unavailable`);
			const result = await withComposeFiles(
				executable,
				undefined,
				undefined,
				(files) =>
					run(
						command,
						composeArgs(provider, files, executable.project, [
							"ps",
							"-q",
							...(provider === "podman" ? [] : executable.services),
						]),
						{
							cwd,
							env: { ...engineEnv(provider, executable.socket), ...env },
							timeoutSec: 30,
							signal,
							redact: (value) => value,
						},
					),
			);
			if (result.exitCode !== 0) throw new Error("compose-ps-unavailable");
			const ids = result.output
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => /^[a-f0-9]{12,64}$/.test(line));
			if (!ids.length || ids.length > executable.services.length * 8)
				throw new Error("compose-identity-unavailable");
			return [...new Set(ids)];
		},
		networkCreate: async ({ executable, signal, redact }) => {
			const provider = executable.provider;
			const command = engine(provider);
			if (!command)
				return {
					networkId: null,
					output: `${provider}-unavailable`,
					truncated: false,
				};
			const result = await run(
				command,
				[
					...enginePrefix(provider, executable.socket),
					"network",
					"create",
					"--driver",
					"bridge",
					"--label",
					"environment-mcp=true",
					"--label",
					`environment-mcp-app=${executable.app}`,
					"--label",
					`environment-mcp-target=${executable.target}`,
					executable.network,
				],
				{
					env: engineEnv(provider, executable.socket),
					timeoutSec: executable.timeoutSec,
					signal,
					redact,
				},
			);
			if (result.exitCode !== 0)
				return {
					networkId: null,
					output: result.output,
					truncated: result.truncated,
				};
			const created = result.output
				.trim()
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.at(-1);
			let networkId =
				created && /^[a-f0-9]{12,64}$/.test(created) ? created : undefined;
			if (provider === "podman" || !networkId) {
				const inspected = await (async () => {
					const inspectResult = await run(
						command,
						[
							...enginePrefix(provider, executable.socket),
							"network",
							"inspect",
							executable.network,
						],
						{
							env: engineEnv(provider, executable.socket),
							timeoutSec: 15,
							signal,
							redact,
						},
					);
					if (inspectResult.exitCode !== 0) return undefined;
					try {
						const parsed = JSON.parse(inspectResult.output) as unknown;
						const item = Array.isArray(parsed) ? parsed[0] : parsed;
						if (!item || typeof item !== "object") return undefined;
						const id =
							(item as { Id?: unknown; id?: unknown }).Id ??
							(item as { Id?: unknown; id?: unknown }).id;
						return typeof id === "string" ? id : undefined;
					} catch {
						return undefined;
					}
				})();
				networkId = inspected;
			}
			if (!networkId)
				return {
					networkId: null,
					output: result.output,
					truncated: result.truncated,
				};
			return {
				networkId,
				output: result.output,
				truncated: result.truncated,
			};
		},
		networkInspect: async ({ socket, provider = "docker", name, signal }) => {
			const command = engine(provider);
			if (!command) throw new Error(`${provider}-unavailable`);
			const result = await run(
				command,
				[...enginePrefix(provider, socket), "network", "inspect", name],
				{
					env: engineEnv(provider, socket),
					timeoutSec: 15,
					signal,
					redact: (value) => value,
				},
			);
			if (result.exitCode !== 0) return null;
			try {
				const parsed = JSON.parse(result.output) as unknown;
				const item = Array.isArray(parsed) ? parsed[0] : parsed;
				if (!item || typeof item !== "object") return null;
				const value = item as Record<string, unknown>;
				const id = value.Id ?? value.id;
				const actualName = value.Name ?? value.name;
				if (typeof id !== "string" || typeof actualName !== "string")
					return null;
				const rawLabels = value.Labels ?? value.labels;
				const labels =
					rawLabels &&
					typeof rawLabels === "object" &&
					!Array.isArray(rawLabels)
						? Object.fromEntries(
								Object.entries(rawLabels).filter(
									(entry): entry is [string, string] =>
										typeof entry[1] === "string",
								),
							)
						: {};
				const rawContainers = value.Containers ?? value.containers;
				const containers = Array.isArray(rawContainers)
					? rawContainers
							.map((container) =>
								container && typeof container === "object"
									? ((container as { Id?: unknown; id?: unknown }).Id ??
										(container as { Id?: unknown; id?: unknown }).id)
									: undefined,
							)
							.filter((entry): entry is string => typeof entry === "string")
					: rawContainers && typeof rawContainers === "object"
						? Object.keys(rawContainers)
						: [];
				return { id, name: actualName, labels, containers };
			} catch {
				return null;
			}
		},
		networkConnect: async ({
			socket,
			provider = "docker",
			networkId,
			containers,
			signal,
		}) => {
			const command = engine(provider);
			if (!command) throw new Error(`${provider}-unavailable`);
			const connected: string[] = [];
			for (const container of containers) {
				const result = await run(
					command,
					[
						...enginePrefix(provider, socket),
						"network",
						"connect",
						networkId,
						container,
					],
					{
						env: engineEnv(provider, socket),
						timeoutSec: 30,
						signal,
						redact: (value) => value,
					},
				);
				if (result.exitCode === 0) connected.push(container);
			}
			return connected;
		},
		networkRemove: async ({
			socket,
			provider = "docker",
			networkId,
			name,
			signal,
			redact,
		}) => {
			const command = engine(provider);
			if (!command) return false;
			const before = await run(
				command,
				[...enginePrefix(provider, socket), "network", "inspect", name],
				{
					env: engineEnv(provider, socket),
					timeoutSec: 15,
					signal,
					redact,
				},
			);
			if (before.exitCode !== 0) return true;
			try {
				const parsed = JSON.parse(before.output) as unknown;
				const item = Array.isArray(parsed) ? parsed[0] : parsed;
				const containers =
					item && typeof item === "object"
						? ((item as { Containers?: unknown; containers?: unknown })
								.Containers ??
							(item as { Containers?: unknown; containers?: unknown })
								.containers)
						: undefined;
				if (
					(Array.isArray(containers) && containers.length > 0) ||
					(containers &&
						typeof containers === "object" &&
						Object.keys(containers).length > 0)
				)
					return false;
			} catch {
				return false;
			}
			const removed = await run(
				command,
				[...enginePrefix(provider, socket), "network", "rm", networkId],
				{
					env: engineEnv(provider, socket),
					timeoutSec: 30,
					signal,
					redact,
				},
			);
			if (removed.exitCode !== 0) return false;
			const inspected = await run(
				command,
				[...enginePrefix(provider, socket), "network", "inspect", name],
				{
					env: engineEnv(provider, socket),
					timeoutSec: 15,
					signal,
					redact,
				},
			);
			return inspected.exitCode !== 0;
		},
		helmInstall: async ({ executable, cluster, runLabel, signal, redact }) => {
			const outputs: string[] = [];
			let timedOut = false;
			let truncated = false;
			const finish = (
				exitCode: number | null,
				extra: {
					created?: {
						release: string;
						namespace: string;
						revision: number;
						label: string;
					};
					deployments?: string[];
					readiness?: "ready" | "waiting" | "unknown";
				} = {},
			) => {
				const output = outputs.filter(Boolean).join("\n");
				return {
					exitCode,
					timedOut,
					output:
						output.length > outputLimit
							? `[truncated]\n${output.slice(-outputLimit)}`
							: output,
					truncated: truncated || output.length > outputLimit,
					created: extra.created,
					deployments: extra.deployments ?? [],
					readiness: extra.readiness ?? ("unknown" as const),
				};
			};
			const command = helm;
			if (!command) return finish(null, { readiness: "unknown" });
			const helmRun = async (args: string[], timeoutSec: number) => {
				const result = await run(
					command,
					[...helmClusterArgs(cluster), ...args],
					{
						env: cluster.environment,
						timeoutSec,
						signal,
						redact,
					},
				);
				outputs.push(result.output);
				timedOut ||= result.timedOut;
				truncated ||= result.truncated;
				return result;
			};
			const namespace = executable.namespace;
			const release = executable.release;
			const occupied = await helmRun(
				[
					"list",
					"--namespace",
					namespace,
					"--filter",
					`^${release}$`,
					"-o",
					"json",
				],
				30,
			);
			if (occupied.exitCode !== 0)
				return finish(occupied.exitCode, { readiness: "unknown" });
			try {
				const listed = JSON.parse(occupied.output) as unknown;
				if (!Array.isArray(listed))
					return finish(null, { readiness: "unknown" });
				if (listed.length) return finish(1, { readiness: "unknown" });
			} catch {
				return finish(null, { readiness: "unknown" });
			}
			const inputs = [
				"--namespace",
				namespace,
				...executable.values.flatMap((file) => [
					"--values",
					path.join(executable.chart, file),
				]),
				...Object.entries(executable.setString).flatMap(([key, value]) => [
					"--set-string",
					`${key}=${value}`,
				]),
			];
			const rendered = await helmRun(
				["template", release, executable.chart, ...inputs, "--skip-crds"],
				Math.min(executable.timeoutSec, 120),
			);
			if (rendered.exitCode !== 0)
				return finish(rendered.exitCode, { readiness: "unknown" });
			let planned: string[];
			try {
				planned = helmDeployments(rendered.output, namespace);
			} catch {
				return finish(1, { readiness: "unknown" });
			}
			const installed = await helmRun(
				[
					"install",
					release,
					executable.chart,
					...inputs,
					"--labels",
					`environment-mcp-run=${runLabel}`,
					"--skip-crds",
					"--no-hooks",
				],
				executable.timeoutSec,
			);
			if (installed.exitCode !== 0)
				return finish(installed.exitCode, { readiness: "unknown" });
			const metadata = await helmRun(
				["get", "metadata", release, "--namespace", namespace, "-o", "json"],
				30,
			);
			if (metadata.exitCode !== 0)
				return finish(null, { readiness: "unknown" });
			let revision: number;
			try {
				const parsed = object(JSON.parse(metadata.output));
				const labels = object(parsed.labels);
				if (
					parsed.name !== release ||
					parsed.namespace !== namespace ||
					parsed.revision !== 1 ||
					parsed.status !== "deployed" ||
					labels["environment-mcp-run"] !== runLabel ||
					!Number.isSafeInteger(parsed.revision)
				)
					return finish(null, { readiness: "unknown" });
				revision = Number(parsed.revision);
			} catch {
				return finish(null, { readiness: "unknown" });
			}
			const created = {
				release,
				namespace,
				revision,
				label: runLabel,
			};
			const manifest = await helmRun(
				["get", "manifest", release, "--namespace", namespace],
				30,
			);
			if (manifest.exitCode !== 0)
				return finish(null, {
					created,
					deployments: planned,
					readiness: "unknown",
				});
			try {
				const installedDeployments = helmDeployments(
					manifest.output,
					namespace,
				);
				if (JSON.stringify(installedDeployments) !== JSON.stringify(planned))
					return finish(null, {
						created,
						deployments: planned,
						readiness: "unknown",
					});
				if (!kubectl)
					return finish(null, {
						created,
						deployments: planned,
						readiness: "unknown",
					});
				const deadline =
					Date.now() + Math.min(60_000, executable.timeoutSec * 1000);
				let readiness: "ready" | "waiting" | "unknown" = "waiting";
				while (Date.now() < deadline) {
					const current = await run(
						kubectl,
						[
							...kubectlClusterArgs(cluster),
							"get",
							"deployment",
							...installedDeployments,
							"--namespace",
							namespace,
							"-o",
							"json",
						],
						{
							env: cluster.environment,
							timeoutSec: 10,
							signal,
							redact,
						},
					);
					outputs.push(current.output);
					timedOut ||= current.timedOut;
					truncated ||= current.truncated;
					if (current.exitCode !== 0) {
						readiness = "unknown";
						break;
					}
					try {
						const data = object(JSON.parse(current.output));
						const items = Array.isArray(data.items)
							? data.items.map(object)
							: [object(data)];
						if (items.length !== installedDeployments.length) {
							readiness = "waiting";
						} else {
							const ready = items.every((item) => {
								const metadata = object(item.metadata);
								const annotations = object(metadata.annotations);
								const status = object(item.status);
								const conditions = Array.isArray(status.conditions)
									? status.conditions.map(object)
									: [];
								return (
									installedDeployments.includes(String(metadata.name)) &&
									metadata.namespace === namespace &&
									annotations["meta.helm.sh/release-name"] === release &&
									annotations["meta.helm.sh/release-namespace"] === namespace &&
									Number.isSafeInteger(metadata.generation) &&
									Number(status.observedGeneration) >=
										Number(metadata.generation) &&
									conditions.some(
										(condition) =>
											condition.type === "Available" &&
											condition.status === "True",
									)
								);
							});
							readiness = ready ? "ready" : "waiting";
						}
					} catch {
						readiness = "unknown";
						break;
					}
					if (readiness === "ready") break;
					await Bun.sleep(500);
					signal.throwIfAborted();
				}
				return finish(0, {
					created,
					deployments: installedDeployments,
					readiness,
				});
			} catch {
				return finish(null, {
					created,
					deployments: planned,
					readiness: "unknown",
				});
			}
		},
		helmUninstall: async ({
			cluster,
			release,
			namespace,
			revision,
			label,
			signal,
			redact,
		}) => {
			const command = helm;
			if (!command) return false;
			const helmRun = (args: string[], timeoutSec: number) =>
				run(command, [...helmClusterArgs(cluster), ...args], {
					env: cluster.environment,
					timeoutSec,
					signal,
					redact,
				});
			const list = () =>
				helmRun(
					[
						"list",
						"--namespace",
						namespace,
						"--filter",
						`^${release}$`,
						"-o",
						"json",
					],
					30,
				);
			const metadata = await helmRun(
				["get", "metadata", release, "--namespace", namespace, "-o", "json"],
				30,
			);
			if (metadata.exitCode !== 0) {
				const absent = await list();
				if (absent.exitCode !== 0) return false;
				try {
					const listed = JSON.parse(absent.output) as unknown;
					return Array.isArray(listed) && listed.length === 0;
				} catch {
					return false;
				}
			}
			try {
				const parsed = object(JSON.parse(metadata.output));
				const labels = object(parsed.labels);
				if (
					parsed.name !== release ||
					parsed.namespace !== namespace ||
					parsed.revision !== revision ||
					labels["environment-mcp-run"] !== label
				)
					return false;
			} catch {
				return false;
			}
			const removed = await helmRun(
				["uninstall", release, "--namespace", namespace, "--wait"],
				60,
			);
			if (removed.exitCode !== 0) return false;
			const absent = await list();
			if (absent.exitCode !== 0) return false;
			try {
				const listed = JSON.parse(absent.output) as unknown;
				return Array.isArray(listed) && listed.length === 0;
			} catch {
				return false;
			}
		},
		containersReady: async ({
			socket,
			provider = "docker",
			containers,
			requireHealth = false,
			signal,
		}) => {
			if (!containers.length)
				return {
					readiness: "unknown" as const,
					source: `${provider}-running` as const,
				};
			try {
				const states = (
					await inspect(provider, socket, containers, signal)
				).map((line) => {
					const [running, health = "none"] = line.split("\t");
					return { running: running === "true", health };
				});
				if (states.some((state) => !state.running))
					return {
						readiness: "waiting" as const,
						source: `${provider}-running` as const,
					};
				if (states.every((state) => state.health === "none")) {
					if (requireHealth)
						return {
							readiness: "unknown" as const,
							source: `${provider}-health` as const,
						};
					return {
						readiness: "ready" as const,
						source: `${provider}-running` as const,
					};
				}
				return {
					readiness: states.some((state) => state.health !== "healthy")
						? ("waiting" as const)
						: ("ready" as const),
					source: `${provider}-health` as const,
				};
			} catch {
				return {
					readiness: "unknown" as const,
					source: `${provider}-running` as const,
				};
			}
		},
		probeEndpoints: async ({ endpoints, signal }) => {
			const statuses: Record<string, "ready" | "unreachable"> = {};
			await Promise.all(
				endpoints.slice(0, 8).map(async ({ name, url }) => {
					const timeout = new AbortController();
					const timer = setTimeout(() => timeout.abort(), 1000);
					try {
						const response = await fetch(url, {
							method: "GET",
							redirect: "manual",
							signal: AbortSignal.any([signal, timeout.signal]),
						});
						await response.body?.cancel();
						statuses[name] =
							response.status >= 200 && response.status < 400
								? "ready"
								: "unreachable";
					} catch {
						signal.throwIfAborted();
						statuses[name] = "unreachable";
					} finally {
						clearTimeout(timer);
					}
				}),
			);
			return statuses;
		},
		stopContainers: async ({
			containers,
			socket,
			provider = "docker",
			signal,
		}) => {
			const command = engine(provider);
			if (!command) throw new Error(`${provider}-unavailable`);
			const stopped: string[] = [];
			for (const id of containers.slice(0, 32)) {
				const result = await run(
					command,
					[...enginePrefix(provider, socket), "rm", "-f", id],
					{
						env: engineEnv(provider, socket),
						timeoutSec: 30,
						signal,
						redact: (value) => value,
					},
				);
				if (result.exitCode === 0) stopped.push(id);
			}
			return stopped;
		},
		logs: async ({
			containers,
			socket,
			provider = "docker",
			tail,
			redact,
			signal,
		}) => {
			const command = engine(provider);
			if (!command) throw new Error(`${provider}-unavailable`);
			const parts: string[] = [];
			for (const id of containers.slice(0, 8)) {
				const result = await run(
					command,
					[
						...enginePrefix(provider, socket),
						"logs",
						"--tail",
						String(tail),
						id,
					],
					{
						env: engineEnv(provider, socket),
						timeoutSec: 20,
						signal,
						redact,
					},
				);
				parts.push(`== ${id.slice(0, 12)} ==\n${result.output}`);
			}
			const text = parts.join("\n");
			return text.slice(0, 48 * 1024);
		},
	};
}

/** Resolve only declared environment references; never expand an empty or
 * caller-authored name. Missing references refuse before issuance. */
export function resolveExecutionEnvironment(refs: Record<string, string>) {
	const values: Record<string, string> = {};
	for (const [key, reference] of Object.entries(refs)) {
		const value = process.env[reference];
		if (!value) throw new Error("execution-credential-reference-unavailable");
		values[key] = value;
	}
	return values;
}

export function redactValues(values: readonly string[]) {
	return (text: string) =>
		values
			.filter((value) => value.length >= 4)
			.reduce(
				(current, value) => current.split(value).join("[REDACTED]"),
				text,
			);
}
