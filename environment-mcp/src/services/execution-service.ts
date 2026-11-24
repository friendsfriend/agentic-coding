import fs from "node:fs";
import {
	buildSecretRedactionValues,
	resolveBuildSecrets,
} from "../configuration/build-secrets.ts";
import { verifyHelmChart } from "../configuration/helm-chart.ts";
import { clusterConnection } from "../configuration/kubernetes-cluster.ts";
import {
	resolveReferences,
	type SecretSource,
} from "../configuration/secrets.ts";
import type { ServerManifest } from "../configuration/server-manifest.ts";
import {
	type ContainerInspectionPort,
	matchBorrowedContainer,
} from "../domain/dependency-binding.ts";
import {
	type Executable,
	type ExecutionPort,
	type ExecutionReceipt,
	executionDescriptorSchema,
	executionIntentSchema,
	type ProcessHandle,
} from "../domain/execution.ts";
import { OperationRefusal, operationView } from "../domain/operation.ts";
import type { OwnedResource } from "../domain/owned-resource.ts";
import type { SharedService } from "../domain/shared-service.ts";
import { createTelemetryReceiver } from "../telemetry/receiver.ts";
import { createDependencyBindingService } from "./dependency-binding-service.ts";
import type { EnvironmentEventInput } from "./event-bus.ts";
import type { OperationJournal } from "./operation-journal.ts";

const receiptOutputLimit = 24 * 1024;
const truncate = (value: string) =>
	value.length > receiptOutputLimit
		? `[truncated]\n${value.slice(value.length - receiptOutputLimit)}`
		: value;

type FrozenDependency = {
	service: string;
	lifecycle: "shared" | "external" | "owned";
	binding: unknown;
	identity: unknown;
	action: "reuse";
	cleanup: "never";
};

async function gitHead(directory: string) {
	const child = Bun.spawn(["git", "-C", directory, "rev-parse", "HEAD"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const [code, output] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
	]);
	if (code !== 0 || !/^[a-f0-9]{40,64}\n?$/.test(output))
		throw new OperationRefusal("operation-unavailable");
	return output.trim();
}

/** Re-observe exactly the reviewed dependency identity; never replace the frozen
 * review with a newer generation. */
async function revalidateFrozen(
	manifest: ServerManifest,
	frozen: readonly FrozenDependency[],
	containers: ContainerInspectionPort,
	signal: AbortSignal,
) {
	for (const dependency of frozen) {
		signal.throwIfAborted();
		const service = manifest.services.find(
			(service) => service.id === dependency.service,
		);
		if (!service?.binding) throw new OperationRefusal("operation-unavailable");
		const inspection = await containers.inspect(service.binding, signal);
		if (inspection.status !== "present")
			throw new OperationRefusal("operation-unavailable");
		const observation = matchBorrowedContainer(
			service.binding,
			inspection.document,
		);
		if (!observation.ready) throw new OperationRefusal("operation-unavailable");
		const current: FrozenDependency = {
			service: service.id,
			lifecycle: dependency.lifecycle,
			binding: service.binding,
			identity: observation.identity,
			action: "reuse",
			cleanup: "never",
		};
		if (JSON.stringify(current) !== JSON.stringify(dependency))
			throw new OperationRefusal("operation-unavailable");
	}
}

/** Runtime composition over the same durable journal. Borrowed dependencies are
 * revalidated before issuance; only containers created by an issued operation
 * can enter the owned ledger, and cleanup is exact-ID. */
export function createExecutionService(
	manifest: ServerManifest,
	journal: OperationJournal,
	containers: ContainerInspectionPort,
	executor: ExecutionPort,
	secrets: SecretSource,
	options: {
		telemetryDirectory?: string;
		configDir?: string;
		onEvent?: (event: EnvironmentEventInput) => void;
	} = {},
) {
	let configurationRevision = 0;
	const ensureSecrets = (executable: Executable) => {
		const refs: string[] = [];
		const add = (values: Record<string, string>) => {
			refs.push(...Object.values(values));
		};
		if (
			executable.kind === "command" ||
			executable.kind === "process" ||
			executable.kind === "container-run"
		)
			add(executable.envRefs);
		else if (executable.kind === "compose") {
			add(executable.envRefs);
			for (const service of Object.values(executable.serviceEnvRefs))
				add(service);
		} else if (executable.kind === "docker-build") {
			for (const secret of executable.secrets)
				if (secret.kind === "template") add(secret.refs);
				else if (secret.kind === "env") refs.push(secret.env);
		}
		for (const reference of new Set(refs))
			if (!secrets.get(reference))
				throw new OperationRefusal("secret-reference-unavailable");
	};
	const cleanupShared = async (service: SharedService, signal: AbortSignal) => {
		if (service.leases.length > 0) return;
		const stopped = await executor.stopContainers({
			containers: service.containers,
			socket: service.socket,
			provider: service.provider,
			signal,
		});
		const confirmed = service.containers.filter((container) =>
			stopped.includes(container),
		);
		if (confirmed.length)
			journal.confirmSharedRelease(service.service, confirmed);
	};
	return {
		/** Called only by the controller's synchronous idle-only refresh. Keep the
		 * manifest identity stable for repository resolvers and bound sessions. */
		refresh(next: ServerManifest) {
			Object.assign(manifest, next);
			configurationRevision++;
		},
		bind(principal: string, scopeId: string) {
			const session = journal.bind(principal, scopeId);
			const requireRepository = (repository?: string) => {
				if (repository && repository !== session.scope().workspace.directory)
					throw new OperationRefusal("repository-unauthorized");
			};
			let redactionCache: string[] | undefined;
			let redactionRevision = configurationRevision;
			const redactionValues = () => {
				if (redactionRevision !== configurationRevision) {
					redactionCache = undefined;
					redactionRevision = configurationRevision;
				}
				if (redactionCache) return redactionCache;
				const values: string[] = [];
				for (const app of manifest.apps)
					for (const target of app.targets) {
						const executable = target.executable;
						if (!executable) continue;
						if (executable.kind === "docker-build") {
							values.push(
								...buildSecretRedactionValues(executable.secrets, secrets),
							);
							continue;
						}
						if (
							executable.kind === "helm-release" ||
							executable.kind === "network-only"
						)
							continue;
						for (const reference of Object.values(executable.envRefs)) {
							const value = secrets.get(reference);
							if (value) values.push(value);
						}
					}
				redactionCache = values;
				return values;
			};
			const redact = (text: string) =>
				redactionValues().reduce(
					(current, value) =>
						value.length >= 4
							? current.split(value).join("[REDACTED]")
							: current,
					text,
				);
			const runs = new Map<
				string,
				{ controller: AbortController; promise: Promise<void> }
			>();
			const liveOutputLimit = 4 * 1024 * 1024;
			const liveOutput = new Map<
				string,
				{ text: string; total: number; carry: string }
			>();
			const redactionCarryLength = Math.min(
				65536,
				Math.max(128, ...redactionValues().map((value) => value.length)),
			);
			const appendLiveOutput = (id: string, chunk: string) => {
				if (!chunk) return;
				const current = liveOutput.get(id) ?? {
					text: "",
					total: 0,
					carry: "",
				};
				const combined = current.carry + chunk;
				const redacted = redact(combined);
				const redactedCarry = current.carry ? redact(current.carry) : "";
				const addition =
					redactedCarry && redacted.startsWith(redactedCarry)
						? redacted.slice(redactedCarry.length)
						: redacted;
				const next = current.text + addition;
				liveOutput.set(id, {
					text:
						next.length > liveOutputLimit
							? next.slice(next.length - liveOutputLimit)
							: next,
					total: current.total + addition.length,
					carry: combined.slice(-redactionCarryLength),
				});
			};
			const filterLogs = (text: string, grep: string | undefined) =>
				grep
					? text
							.split("\n")
							.filter((line) => line.includes(grep))
							.join("\n")
					: text;
			const retainedLogs = new Map<
				string,
				{ output: string; retainedAt: number }
			>();
			const processHandles = new Map<
				string,
				{
					app: string;
					handle: ProcessHandle;
					telemetry?: ReturnType<typeof createTelemetryReceiver>;
				}
			>();
			const telemetryByApp = new Map<
				string,
				ReturnType<typeof createTelemetryReceiver>
			>();
			const dispatch = async (
				permit: NonNullable<
					Awaited<ReturnType<typeof session.issue>>["permit"]
				>,
				frozen: {
					intent: { app: string; target: string };
					descriptor: {
						action: "build" | "test" | "run";
						executable: Executable;
						prerequisites: {
							app: string;
							target: string;
							executable: Executable;
						}[];
						endpoints: Record<string, string>;
						endpointServices: Record<string, string>;
					};
					dependencies: { dependencies: FrozenDependency[] } | null;
				},
				cwd: string,
				signal: AbortSignal,
			) => {
				const sharedServiceIds =
					frozen.dependencies?.dependencies.map((item) => item.service) ?? [];
				try {
					if (sharedServiceIds.length)
						session.acquireSharedLeases(
							sharedServiceIds,
							frozen.intent.app,
							frozen.intent.target,
						);
					let receipt: ExecutionReceipt;
					const executable = frozen.descriptor.executable;
					if (executable.kind === "process") {
						if (!executor.processStart)
							throw new Error("process-runtime-unavailable");
						const receiver = executable.telemetry
							? createTelemetryReceiver({
									app: frozen.intent.app,
									scope: scopeId,
									redact,
								})
							: undefined;
						const env = {
							...resolveReferences(secrets, executable.envRefs),
							...(receiver?.env ?? {}),
						};
						let handle: ProcessHandle;
						try {
							handle = await executor.processStart({
								executable,
								cwd,
								env,
								signal,
							});
						} catch (error) {
							receiver?.close();
							throw error;
						}
						let owned: OwnedResource[];
						try {
							owned = session.claimOwned(permit, frozen.intent.app, [
								{ kind: "process", runtimeId: `pid:${handle.pid}` },
							]);
						} catch (error) {
							await handle.stop();
							throw error;
						}
						processHandles.set(permit.id, {
							app: frozen.intent.app,
							handle,
							...(receiver ? { telemetry: receiver } : {}),
						});
						if (receiver) {
							telemetryByApp.get(frozen.intent.app)?.close();
							telemetryByApp.set(frozen.intent.app, receiver);
						}
						let ready: boolean;
						try {
							ready = await handle.ready(signal);
						} catch (error) {
							const stopped = await handle.stop();
							if (stopped)
								session.confirmReleased(owned.map((item) => item.id));
							throw error;
						}
						const source = executable.readyUrl
							? "endpoint"
							: executable.readyText
								? "text"
								: "process";
						const output = handle.output();
						if (!ready || handle.exited()) {
							const stopped = await handle.stop();
							if (stopped)
								session.confirmReleased(owned.map((item) => item.id));
							receipt = {
								status: "failed",
								kind: "process",
								pid: handle.pid,
								readiness: "failed",
								readinessSource: source,
								exitCode: handle.exitCode(),
								output: truncate(redact(output)),
								truncated: Buffer.byteLength(output) > receiptOutputLimit,
							};
							if (!stopped)
								session.complete(
									permit,
									JSON.stringify({ ...receipt, inspectionRequired: true }),
									true,
								);
						} else {
							receipt = {
								status: "completed",
								kind: "process",
								pid: handle.pid,
								readiness: "ready",
								readinessSource: source,
								exitCode: null,
								output: truncate(redact(output)),
								truncated: Buffer.byteLength(output) > receiptOutputLimit,
							};
						}
						session.complete(permit, JSON.stringify(receipt));
						return;
					}
					if (executable.kind === "command") {
						const env = resolveReferences(secrets, executable.envRefs);
						const result = await executor.command({
							executable,
							cwd,
							env,
							redact,
							onOutput: (chunk) => appendLiveOutput(permit.id, chunk),
							signal,
						});
						receipt = {
							status: result.exitCode === 0 ? "completed" : "failed",
							kind: "command",
							exitCode: result.exitCode,
							timedOut: result.timedOut,
							output: truncate(result.output),
							truncated: result.truncated,
						};
					} else if (executable.kind === "docker-build") {
						const secretValues = resolveBuildSecrets(
							executable.secrets,
							secrets,
						);
						const result = await executor.dockerBuild({
							executable,
							cwd,
							secrets: secretValues,
							redact,
							onOutput: (chunk) => appendLiveOutput(permit.id, chunk),
							signal,
						});
						receipt = {
							status: result.exitCode === 0 ? "completed" : "failed",
							kind: "docker-build",
							exitCode: result.exitCode,
							timedOut: result.timedOut,
							output: truncate(result.output),
							truncated: result.truncated,
							image: executable.image,
						};
					} else if (executable.kind === "container-run") {
						if (!executor.containerRun)
							throw new Error("container-runtime-unavailable");
						const refs = resolveReferences(secrets, executable.envRefs);
						const receiver = executable.telemetry
							? createTelemetryReceiver({
									app: frozen.intent.app,
									scope: scopeId,
									redact,
									transport: "tls-host-gateway-v1",
									stateDir: options.telemetryDirectory,
								})
							: undefined;
						const env = {
							...executable.env,
							...refs,
							...(receiver?.containerEnvironment() ?? {}),
						};
						let result: Awaited<
							ReturnType<NonNullable<ExecutionPort["containerRun"]>>
						>;
						try {
							result = await executor.containerRun({
								executable,
								cwd,
								env,
								...(receiver
									? {
											telemetry: {
												certificate: receiver.collectorCertificatePath(),
											},
										}
									: {}),
								redact,
								signal,
							});
						} catch (error) {
							receiver?.close();
							throw error;
						}
						if (!result.containerId) {
							receiver?.close();
							session.complete(
								permit,
								JSON.stringify({
									status: "failed",
									kind: "container",
									containerId: "",
									readiness: "unknown",
									readinessSource: `${executable.provider}-running`,
									output: truncate(result.output),
									truncated: result.truncated,
								}),
								true,
							);
							return;
						}
						try {
							session.claimOwned(permit, frozen.intent.app, [
								{ kind: "container", runtimeId: result.containerId },
							]);
						} catch (error) {
							try {
								await executor.stopContainers({
									containers: [result.containerId],
									socket: executable.socket,
									provider: executable.provider,
									signal,
								});
							} catch {
								/* Retain inspection through the original operation. */
							}
							receiver?.close();
							throw error;
						}
						if (receiver) {
							telemetryByApp.get(frozen.intent.app)?.close();
							telemetryByApp.set(frozen.intent.app, receiver);
						}
						signal.throwIfAborted();
						let readiness: "ready" | "waiting" | "unknown" = "waiting";
						let readinessSource:
							| "docker-health"
							| "docker-running"
							| "podman-health"
							| "podman-running" = `${executable.provider}-running`;
						const deadline = Math.min(
							Date.now() + executable.timeoutSec * 1000,
							Date.now() + 60_000,
						);
						for (;;) {
							const state = await executor.containersReady({
								socket: executable.socket,
								provider: executable.provider,
								containers: [result.containerId],
								requireHealth: executable.readiness === "healthy",
								signal,
							});
							readiness = state.readiness;
							readinessSource = state.source;
							signal.throwIfAborted();
							if (readiness !== "waiting" || Date.now() >= deadline) break;
							await Bun.sleep(250);
						}
						receipt = {
							status: readiness === "ready" ? "completed" : "starting",
							kind: "container",
							containerId: result.containerId,
							readiness,
							readinessSource,
							output: truncate(result.output),
							truncated: result.truncated,
						};
					} else if (executable.kind === "helm-release") {
						if (!executor.helmInstall)
							throw new Error("helm-runtime-unavailable");
						if (!options.configDir)
							throw new Error("kubernetes-cluster-unavailable");
						verifyHelmChart(executable.chart, executable.chartDigest);
						const cluster = clusterConnection(
							options.configDir,
							manifest.repositories,
							executable.cluster,
							executable.clusterDigest,
						);
						const result = await executor.helmInstall({
							executable,
							cluster,
							runLabel: permit.id,
							signal,
							redact,
						});
						let owned: OwnedResource | undefined;
						if (result.created) {
							const runtimeId = JSON.stringify({
								cluster: executable.cluster,
								clusterDigest: executable.clusterDigest,
								namespace: result.created.namespace,
								release: result.created.release,
								revision: result.created.revision,
								label: result.created.label,
							});
							if (Buffer.byteLength(runtimeId) > 512)
								throw new Error("helm-identity-too-large");
							try {
								owned = session.claimOwned(permit, frozen.intent.app, [
									{ kind: "helm-release", runtimeId },
								])[0];
							} catch (error) {
								if (executor.helmUninstall)
									try {
										await executor.helmUninstall({
											executable,
											cluster,
											release: result.created.release,
											namespace: result.created.namespace,
											revision: result.created.revision,
											label: result.created.label,
											signal: AbortSignal.timeout(30_000),
											redact,
										});
									} catch {
										/* The release remains inspection-only. */
									}
								throw error;
							}
						}
						if (result.exitCode !== 0 || !owned) {
							session.complete(
								permit,
								JSON.stringify({
									status: "failed",
									kind: "helm",
									release: executable.release,
									namespace: executable.namespace,
									deployments: result.deployments,
									readiness: result.readiness,
									readinessSource: "helm-deployments",
									output: truncate(result.output),
									truncated: result.truncated,
									...(owned ? {} : { inspectionRequired: true }),
								}),
								true,
							);
							return;
						}
						receipt = {
							status: result.readiness === "ready" ? "completed" : "starting",
							kind: "helm",
							release: executable.release,
							namespace: executable.namespace,
							deployments: result.deployments,
							readiness: result.readiness,
							readinessSource: "helm-deployments",
							output: truncate(result.output),
							truncated: result.truncated,
						};
					} else if (executable.kind === "network-only") {
						if (!executor.networkCreate)
							throw new Error("network-runtime-unavailable");
						const result = await executor.networkCreate({
							executable,
							signal,
							redact,
						});
						if (!result.networkId) {
							session.complete(
								permit,
								JSON.stringify({
									status: "failed",
									kind: "network",
									networkId: "",
									name: executable.network,
									readiness: "ready",
									readinessSource: `${executable.provider}-network`,
									output: truncate(result.output),
									truncated: result.truncated,
									inspectionRequired: true,
								}),
								true,
							);
							return;
						}
						const runtimeId = JSON.stringify({
							networkId: result.networkId,
							name: executable.network,
							provider: executable.provider,
							socket: executable.socket,
						});
						if (Buffer.byteLength(runtimeId) > 512)
							throw new Error("network-identity-too-large");
						try {
							session.claimOwned(permit, frozen.intent.app, [
								{ kind: "network", runtimeId },
							]);
						} catch (error) {
							if (executor.networkRemove)
								try {
									await executor.networkRemove({
										socket: executable.socket,
										provider: executable.provider,
										networkId: result.networkId,
										name: executable.network,
										signal: AbortSignal.timeout(30_000),
										redact,
									});
								} catch {
									/* The network remains inspection-only. */
								}
							throw error;
						}
						receipt = {
							status: "completed",
							kind: "network",
							networkId: result.networkId,
							name: executable.network,
							readiness: "ready",
							readinessSource: `${executable.provider}-network`,
							output: truncate(result.output),
							truncated: result.truncated,
						};
					} else {
						const env = resolveReferences(secrets, executable.envRefs);
						let networkId: string | undefined;
						if (executable.networkFrom) {
							if (
								!executor.networkInspect ||
								!executor.networkCreate ||
								!executor.networkRemove
							)
								throw new Error("network-runtime-unavailable");
							const network = await executor.networkInspect({
								socket: executable.socket,
								provider: executable.provider,
								name: executable.networkFrom.network,
								signal,
							});
							if (network) {
								if (
									network.name !== executable.networkFrom.network ||
									network.labels["environment-mcp-app"] !==
										executable.networkFrom.app ||
									network.labels["environment-mcp-target"] !==
										executable.networkFrom.target
								)
									throw new Error("compose-network-prerequisite-unavailable");
								networkId = network.id;
							} else {
								const prerequisite = frozen.descriptor.prerequisites.find(
									(candidate) =>
										candidate.app === executable.networkFrom?.app &&
										candidate.target === executable.networkFrom?.target,
								);
								if (prerequisite?.executable.kind !== "network-only")
									throw new Error("compose-network-prerequisite-unavailable");
								const prerequisiteExecutable = prerequisite.executable;
								const created = await executor.networkCreate({
									executable: prerequisiteExecutable,
									signal,
									redact,
								});
								if (!created.networkId)
									throw new Error("compose-network-prerequisite-unavailable");
								try {
									session.claimOwned(permit, frozen.intent.app, [
										{
											kind: "network",
											runtimeId: JSON.stringify({
												networkId: created.networkId,
												name: prerequisite.executable.network,
												provider: prerequisite.executable.provider,
												socket: prerequisite.executable.socket,
											}),
										},
									]);
								} catch (error) {
									try {
										await executor.networkRemove({
											socket: prerequisiteExecutable.socket,
											provider: prerequisiteExecutable.provider,
											networkId: created.networkId,
											name: prerequisiteExecutable.network,
											signal: AbortSignal.timeout(30_000),
											redact,
										});
									} catch {
										/* The bridge remains inspection-only. */
									}
									throw error;
								}
								networkId = created.networkId;
							}
						}
						const serviceEnv: Record<
							string,
							Record<string, string>
						> = Object.fromEntries(
							Object.entries(executable.serviceEnvRefs).map(
								([service, refs]) => [
									service,
									resolveReferences(secrets, refs),
								],
							),
						);
						const receiver = executable.telemetry
							? createTelemetryReceiver({
									app: frozen.intent.app,
									scope: scopeId,
									redact,
									transport: "tls-host-gateway-v1",
									stateDir: options.telemetryDirectory,
								})
							: undefined;
						const serviceMounts: Record<
							string,
							{ source: string; target: string }[]
						> = {};
						if (receiver && executable.telemetry) {
							const collector = executable.telemetry.collectorService;
							serviceEnv[collector] = {
								...(serviceEnv[collector] ?? {}),
								...receiver.collectorEnvironment(),
							};
							serviceMounts[collector] = [
								{
									source: receiver.collectorCertificatePath(),
									target: "/environment-mcp-otel-ca.pem",
								},
							];
						}
						let result: Awaited<ReturnType<ExecutionPort["composeUp"]>>;
						try {
							result = await executor.composeUp({
								executable,
								cwd,
								env,
								serviceEnv,
								serviceMounts,
								redact,
								signal,
							});
						} catch (error) {
							receiver?.close();
							throw error;
						}
						if (result.exitCode !== 0) {
							receiver?.close();
							session.complete(
								permit,
								JSON.stringify({
									status: "failed",
									kind: "compose",
									output: truncate(result.output),
									inspectionRequired: true,
								}),
								true,
							);
							return;
						}
						if (receiver) {
							telemetryByApp.get(frozen.intent.app)?.close();
							telemetryByApp.set(frozen.intent.app, receiver);
						}
						const ids = await executor.composeContainers({
							executable,
							cwd,
							env,
							signal,
						});
						const owned = session.claimOwned(
							permit,
							frozen.intent.app,
							ids.map((runtimeId) => ({
								kind: "container" as const,
								runtimeId,
							})),
						);
						signal.throwIfAborted();
						if (networkId) {
							if (!executor.networkConnect)
								throw new Error("network-runtime-unavailable");
							const connected = await executor.networkConnect({
								socket: executable.socket,
								provider: executable.provider,
								networkId,
								containers: ids,
								signal,
							});
							if (connected.length !== ids.length)
								throw new Error("compose-network-attach-failed");
						}
						const endpoints = Object.entries(frozen.descriptor.endpoints).map(
							([name, url]) => ({ name, url }),
						);
						let endpointsObserved: {
							name: string;
							url: string;
							status: "ready" | "unreachable";
						}[] = endpoints.map((endpoint) => ({
							...endpoint,
							status: "unreachable" as const,
						}));
						let readiness: "ready" | "waiting" | "unknown" = "waiting";
						let readinessSource:
							| "endpoint"
							| "docker-health"
							| "docker-running"
							| "podman-health"
							| "podman-running" = "docker-running";
						const deadline = Math.min(
							Date.now() + executable.timeoutSec * 1000,
							Date.now() + 60_000,
						);
						for (;;) {
							const containerState = await executor.containersReady({
								socket: executable.socket,
								provider: executable.provider,
								containers: ids,
								signal,
							});
							readiness = containerState.readiness;
							readinessSource = containerState.source;
							if (endpoints.length) {
								readinessSource = "endpoint";
								if (
									containerState.readiness === "ready" &&
									executor.probeEndpoints
								) {
									const probed = await executor.probeEndpoints({
										endpoints,
										signal,
									});
									endpointsObserved = endpoints.map((endpoint) => ({
										...endpoint,
										status: probed[endpoint.name] ?? "unreachable",
									}));
									readiness = endpointsObserved.every(
										(endpoint) => endpoint.status === "ready",
									)
										? "ready"
										: "waiting";
								} else if (containerState.readiness === "ready") {
									// An endpoint was declared but this runtime cannot probe it; running
									// containers are not evidence that the application is ready.
									readiness = "unknown";
								}
							}
							signal.throwIfAborted();
							if (readiness !== "waiting" || Date.now() >= deadline) break;
							await Bun.sleep(250);
						}
						if (readiness === "ready") {
							for (const service of manifest.services) {
								const start = service.binding?.start;
								if (
									!service.binding ||
									start?.app !== frozen.intent.app ||
									start.target !== frozen.intent.target
								)
									continue;
								try {
									const inspection = await containers.inspect(
										service.binding,
										signal,
									);
									if (
										inspection.status === "present" &&
										matchBorrowedContainer(service.binding, inspection.document)
											.ready
									)
										session.installSharedService(
											permit,
											service.id,
											ids,
											executable.socket,
											executable.provider,
										);
								} catch {
									/* Observation failure leaves the service unregistered. */
								}
							}
						}
						receipt = {
							status: readiness === "ready" ? "completed" : "starting",
							kind: "compose",
							services: executable.services,
							containers: owned.map((item) => item.runtimeId),
							readiness,
							readinessSource,
							...(endpoints.length ? { endpoints: endpointsObserved } : {}),
							output: truncate(result.output),
							truncated: result.truncated,
						};
					}
					session.complete(permit, JSON.stringify(receipt));
				} catch {
					try {
						if (!session.owned().some((item) => item.app === frozen.intent.app))
							session.releaseSharedLeases(frozen.intent.app, sharedServiceIds);
					} catch {
						/* Retain leases for inspection. */
					}
					try {
						session.complete(
							permit,
							JSON.stringify({
								error:
									"Execution became uncertain; inspect the original operation and any created resources. No automatic resend.",
							}),
							true,
						);
					} catch {
						/* Retain the interrupted issuance for inspection. */
					}
				}
			};
			const providerOf = (owned: OwnedResource) => {
				const operation = session.read(owned.operation);
				const descriptor = (
					JSON.parse(operation.plan) as {
						descriptor: { executable: Executable };
					}
				).descriptor;
				return descriptor.executable.kind === "compose" ||
					descriptor.executable.kind === "container-run"
					? (descriptor.executable.provider ?? "docker")
					: "docker";
			};
			const socketOf = (owned: OwnedResource) => {
				const operation = session.read(owned.operation);
				const descriptor = (
					JSON.parse(operation.plan) as {
						descriptor: { executable: Executable };
					}
				).descriptor;
				if (
					descriptor.executable.kind !== "compose" &&
					descriptor.executable.kind !== "container-run"
				)
					throw new OperationRefusal("operation-unavailable");
				return descriptor.executable.socket;
			};
			return {
				async admit(
					requestId: string,
					rawIntent: unknown,
					signal: AbortSignal,
				) {
					const intent = executionIntentSchema.parse(rawIntent);
					const identity = JSON.stringify({ kind: "executable", ...intent });
					const previous = session.find(requestId, identity);
					if (previous) return operationView(previous, journal.host);
					const scope = session.scope(true);
					if (
						intent.repository &&
						intent.repository !== scope.workspace.directory
					)
						throw new OperationRefusal("repository-unauthorized");
					const app = manifest.apps.find(
						(app) =>
							app.id === intent.app &&
							app.repository === scope.workspace.directory,
					);
					const target = app?.targets.find(
						(target) => target.id === intent.target,
					);
					if (!app || !target?.executable) {
						console.error(
							"DEBUG target",
							JSON.stringify({
								intent,
								directory: scope.workspace.directory,
								apps: manifest.apps.map((entry) => [
									entry.id,
									entry.repository,
								]),
								targets: app?.targets.map((entry) => entry.id),
							}),
						);
						throw new OperationRefusal("operation-unavailable");
					}
					const prerequisites = target.prerequisites.map((prerequisite) => {
						const prerequisiteApp = manifest.apps.find(
							(app) => app.id === prerequisite.app,
						);
						const prerequisiteTarget = prerequisiteApp?.targets.find(
							(candidate) => candidate.id === prerequisite.target,
						);
						if (prerequisiteTarget?.executable?.kind !== "network-only")
							throw new OperationRefusal("operation-unavailable");
						return {
							...prerequisite,
							executable: prerequisiteTarget.executable,
						};
					});
					const descriptor = executionDescriptorSchema.parse({
						action: target.action,
						executable: target.executable,
						prerequisites,
						endpoints: target.endpoints,
						endpointServices: target.endpointServices,
					});
					if (
						descriptor.executable.kind === "compose" &&
						descriptor.executable.file
					) {
						// Trusted configuration may place a compose file outside the
						// repository (v1 keeps them under its config root). Freeze the
						// canonical path so a symlink swap cannot redirect dispatch.
						const file = fs.realpathSync(descriptor.executable.file);
						if (!fs.lstatSync(file).isFile())
							throw new OperationRefusal("operation-unavailable");
						descriptor.executable.file = file;
					}
					ensureSecrets(descriptor.executable);
					for (const prerequisite of descriptor.prerequisites)
						ensureSecrets(prerequisite.executable);
					if (descriptor.executable.kind === "helm-release")
						verifyHelmChart(
							descriptor.executable.chart,
							descriptor.executable.chartDigest,
						);
					if (
						descriptor.executable.kind === "compose" &&
						descriptor.executable.networkFrom
					) {
						const networkFrom = descriptor.executable.networkFrom;
						const configuredPrerequisite = descriptor.prerequisites.some(
							(prerequisite) =>
								prerequisite.app === networkFrom.app &&
								prerequisite.target === networkFrom.target &&
								prerequisite.executable.kind === "network-only",
						);
						if (!executor.networkInspect)
							throw new OperationRefusal("network-prerequisite-unavailable");
						let network:
							| Awaited<
									ReturnType<NonNullable<ExecutionPort["networkInspect"]>>
							  >
							| undefined;
						try {
							network = await executor.networkInspect({
								socket: descriptor.executable.socket,
								provider: descriptor.executable.provider,
								name: networkFrom.network,
								signal,
							});
						} catch {
							throw new OperationRefusal("network-prerequisite-unavailable");
						}
						if (
							network &&
							(network.name !== networkFrom.network ||
								network.labels["environment-mcp-app"] !== networkFrom.app ||
								network.labels["environment-mcp-target"] !== networkFrom.target)
						)
							throw new OperationRefusal("network-prerequisite-unavailable");
						if (!network && !configuredPrerequisite)
							throw new OperationRefusal("network-prerequisite-unavailable");
					}
					const head = await gitHead(scope.workspace.directory);
					signal.throwIfAborted();
					let dependencies: unknown = null;
					if (target.dependsOn.length) {
						const bindings = createDependencyBindingService(
							manifest,
							scope.workspace.directory,
							containers,
						);
						dependencies = JSON.parse(
							(await bindings.prepare(intent.app, intent.target, signal)).plan,
						);
						signal.throwIfAborted();
					}
					const plan = JSON.stringify({
						kind: "executable",
						scope: scope.id,
						principal,
						workspace: scope.workspace,
						intent,
						descriptor,
						dependencies,
						repositoryHead: head,
						authority:
							"Execute exactly this configured command or Compose project. Only resources created by this issuance may enter cleanup; borrowed dependencies and volumes grant no cleanup authority. Nonzero exits are failures, not successful verification. Cancellation is not rollback of server-side effects.",
					});
					const operation = session.admit(
						requestId,
						identity,
						plan,
						"executable",
					);
					return operationView(operation, journal.host);
				},
				async executeIntent(
					requestId: string,
					rawIntent: unknown,
					signal: AbortSignal,
				) {
					const admitted = await this.admit(requestId, rawIntent, signal);
					if (admitted.state === "approved")
						return this.execute(admitted.id, signal);
					const operation = session.read(admitted.id);
					const receipt = operation.result
						? (JSON.parse(operation.result) as ExecutionReceipt)
						: null;
					return {
						operation: operationView(operation, journal.host),
						receipt,
					};
				},
				read(
					id: string,
					progressOffset = 0,
				): ReturnType<typeof operationView> & {
					progress?: { offset: number; text: string; reset?: boolean };
				} {
					const view = operationView(session.read(id), journal.host);
					const current = liveOutput.get(id);
					if (!current || current.total === 0) return view;
					const chunkLimit = 64 * 1024;
					const requested =
						Number.isFinite(progressOffset) && progressOffset > 0
							? Math.floor(progressOffset)
							: 0;
					const base = current.total - current.text.length;
					if (requested < base)
						return {
							...view,
							progress: {
								offset: current.total,
								text: current.text.slice(-chunkLimit),
								reset: true,
							},
						};
					const offset = Math.min(requested, current.total);
					const start = offset - base;
					const text = current.text.slice(start, start + chunkLimit);
					return {
						...view,
						progress: { offset: offset + text.length, text },
					};
				},
				history(offset = 0, limit = 20, repository?: string) {
					requireRepository(repository);
					return session.history(offset, limit);
				},
				sharedServices() {
					return session.sharedServices();
				},
				sharedService(service: string) {
					return session.sharedService(service);
				},
				isBusy() {
					return runs.size > 0;
				},
				status(repository?: string) {
					requireRepository(repository);
					const scope = session.scope();
					return {
						scope: {
							id: scope.id,
							state: scope.state,
							revision: scope.revision,
						},
						owned: session
							.owned()
							.map(({ id, app, kind, runtimeId, createdAt }) => ({
								id,
								app,
								kind,
								runtimeId,
								createdAt,
							})),
						authority:
							"Observation only; borrowed dependencies are absent from this list and are never stopped here.",
					};
				},
				async execute(id: string, signal: AbortSignal) {
					const operation = session.read(id);
					if (
						operation.kind !== "executable" ||
						operation.state !== "approved" ||
						operation.host !== journal.host
					)
						return {
							operation: operationView(operation, journal.host),
							receipt: null,
						};
					const stored = JSON.parse(operation.plan) as {
						intent: { app: string; target: string };
						descriptor: {
							action: "build" | "test" | "run";
							executable: Executable;
							prerequisites?: {
								app: string;
								target: string;
								executable: Executable;
							}[];
							endpoints?: Record<string, string>;
							endpointServices?: Record<string, string>;
						};
						dependencies: { dependencies: FrozenDependency[] } | null;
					};
					const frozen = {
						...stored,
						descriptor: {
							...stored.descriptor,
							prerequisites: stored.descriptor.prerequisites ?? [],
							endpoints: stored.descriptor.endpoints ?? {},
							endpointServices: stored.descriptor.endpointServices ?? {},
						},
					};
					const scope = session.scope(true);
					if (frozen.dependencies)
						await revalidateFrozen(
							manifest,
							frozen.dependencies.dependencies,
							containers,
							signal,
						);
					signal.throwIfAborted();
					if (runs.has(id)) throw new OperationRefusal("operation-unavailable");
					const issued = session.issue(id, operation);
					const permit = issued.permit;
					if (!permit) throw new OperationRefusal("operation-unavailable");
					const controller = new AbortController();
					const repository = scope.workspace.directory;
					options.onEvent?.({
						type: "operation",
						repository,
						operationId: id,
					});
					options.onEvent?.({ type: "status", repository });
					const promise = dispatch(
						permit,
						frozen,
						repository,
						controller.signal,
					).finally(() => {
						if (runs.get(id)?.controller === controller) runs.delete(id);
						liveOutput.delete(id);
						options.onEvent?.({
							type: "operation",
							repository,
							operationId: id,
						});
						options.onEvent?.({ type: "status", repository });
						options.onEvent?.({ type: "git", repository });
						options.onEvent?.({ type: "services", repository });
					});
					runs.set(id, { controller, promise });
					return {
						operation: operationView(issued.operation, journal.host),
						receipt: null,
					};
				},
				async wait(id: string, waitSec: number, signal: AbortSignal) {
					if (!Number.isInteger(waitSec) || waitSec < 1 || waitSec > 120)
						throw new OperationRefusal("operation-unavailable");
					const pending = runs.get(id);
					if (pending) {
						const timeout = new AbortController();
						const timer = setTimeout(() => timeout.abort(), waitSec * 1000);
						try {
							await Promise.race([
								pending.promise,
								new Promise<void>((resolve) =>
									timeout.signal.addEventListener("abort", () => resolve(), {
										once: true,
									}),
								),
								new Promise<void>((resolve) =>
									signal.addEventListener("abort", () => resolve(), {
										once: true,
									}),
								),
							]);
						} finally {
							clearTimeout(timer);
						}
					}
					const operation = session.read(id);
					const receipt = operation.result
						? (JSON.parse(operation.result) as ExecutionReceipt)
						: null;
					return { operation: operationView(operation, journal.host), receipt };
				},
				async stop(app: string, signal: AbortSignal, repository?: string) {
					requireRepository(repository);
					const owned = session.releaseOwned(app);
					if (!owned.length) {
						telemetryByApp.get(app)?.close();
						return {
							stopped: [],
							remaining: 0,
							retainedLogsAvailable: retainedLogs.has(app),
						};
					}
					const sharedOwners = session.sharedServiceOwners(
						owned.map((item) => item.operation),
					);
					if (sharedOwners.some((service) => service.leases.length > 0))
						throw new OperationRefusal("cleanup-unavailable");
					const processOwned = owned.filter((item) => item.kind === "process");
					const helmOwned = owned.filter(
						(item) => item.kind === "helm-release",
					);
					const networkOwned = owned.filter((item) => item.kind === "network");
					const containerOwned = owned.filter(
						(item) => item.kind === "container",
					);
					const stopped: string[] = [];
					const confirmed: string[] = [];
					const captured: string[] = [];
					for (const item of processOwned) {
						const entry = processHandles.get(item.operation);
						if (!entry) continue;
						const output = redact(entry.handle.output());
						if (output) captured.push(output);
						if (await entry.handle.stop()) {
							entry.telemetry?.close();
							processHandles.delete(item.operation);
							confirmed.push(item.id);
							stopped.push(item.runtimeId);
						}
					}
					for (const item of helmOwned) {
						if (!executor.helmUninstall || !options.configDir) continue;
						try {
							const identity = JSON.parse(item.runtimeId) as {
								cluster?: unknown;
								clusterDigest?: unknown;
								namespace?: unknown;
								release?: unknown;
								revision?: unknown;
								label?: unknown;
							};
							if (
								typeof identity.cluster !== "string" ||
								typeof identity.clusterDigest !== "string" ||
								typeof identity.namespace !== "string" ||
								typeof identity.release !== "string" ||
								typeof identity.revision !== "number" ||
								typeof identity.label !== "string"
							)
								continue;
							const operation = session.read(item.operation);
							const executable = (
								JSON.parse(operation.plan) as {
									descriptor: { executable: Executable };
								}
							).descriptor.executable;
							if (executable.kind !== "helm-release") continue;
							const cluster = clusterConnection(
								options.configDir,
								manifest.repositories,
								identity.cluster,
								identity.clusterDigest,
							);
							const released = await executor.helmUninstall({
								executable,
								cluster,
								release: identity.release,
								namespace: identity.namespace,
								revision: identity.revision,
								label: identity.label,
								signal,
								redact,
							});
							if (released) {
								confirmed.push(item.id);
								stopped.push(`${identity.namespace}/${identity.release}`);
							}
						} catch {
							/* Retain the release record for explicit inspection. */
						}
					}
					if (containerOwned.length) {
						const first = containerOwned[0];
						if (!first) throw new OperationRefusal("operation-unavailable");
						const socket = socketOf(first);
						const provider = providerOf(first);
						try {
							const output = await executor.logs({
								containers: containerOwned.map((item) => item.runtimeId),
								socket,
								tail: 200,
								provider,
								redact,
								signal,
							});
							if (output) captured.push(output);
						} catch {
							// Cleanup must still proceed when log capture is unavailable.
						}
						const containerStopped = await executor.stopContainers({
							containers: containerOwned.map((item) => item.runtimeId),
							socket,
							provider,
							signal,
						});
						for (const item of containerOwned)
							if (containerStopped.includes(item.runtimeId)) {
								confirmed.push(item.id);
								stopped.push(item.runtimeId.slice(0, 12));
							}
					}
					for (const item of networkOwned) {
						if (!executor.networkInspect || !executor.networkRemove) continue;
						try {
							const identity = JSON.parse(item.runtimeId) as {
								networkId?: unknown;
								name?: unknown;
								provider?: unknown;
								socket?: unknown;
							};
							if (
								typeof identity.networkId !== "string" ||
								typeof identity.name !== "string" ||
								(identity.provider !== "docker" &&
									identity.provider !== "podman") ||
								typeof identity.socket !== "string"
							)
								continue;
							const current = await executor.networkInspect({
								socket: identity.socket,
								provider: identity.provider,
								name: identity.name,
								signal,
							});
							if (!current) {
								confirmed.push(item.id);
								stopped.push(identity.name);
								continue;
							}
							if (
								current.id !== identity.networkId ||
								current.name !== identity.name ||
								current.containers.length
							)
								continue;
							const removed = await executor.networkRemove({
								socket: identity.socket,
								provider: identity.provider,
								networkId: identity.networkId,
								name: identity.name,
								signal,
								redact,
							});
							if (removed) {
								confirmed.push(item.id);
								stopped.push(identity.name);
							}
						} catch {
							/* Retain the network record for inspection. */
						}
					}
					const remaining = session.confirmReleased(confirmed);
					if (remaining.filter((item) => item.app === app).length === 0) {
						telemetryByApp.get(app)?.close();
						const released = session.releaseSharedLeases(app);
						for (const service of released)
							try {
								await cleanupShared(service, signal);
							} catch {
								/* Last-release cleanup remains inspection-only on failure. */
							}
						for (const service of sharedOwners)
							session.releaseSharedService(service.operation);
					}
					const output = captured.filter(Boolean).join("\n");
					if (output) {
						if (retainedLogs.size >= 128 && !retainedLogs.has(app))
							retainedLogs.delete(retainedLogs.keys().next().value as string);
						retainedLogs.set(app, { output, retainedAt: Date.now() });
					}
					telemetryByApp.get(app)?.close();
					const repositoryPath = session.scope().workspace.directory;
					options.onEvent?.({ type: "status", repository: repositoryPath });
					options.onEvent?.({ type: "services", repository: repositoryPath });
					return {
						stopped,
						remaining: remaining.filter((item) => item.app === app).length,
						retainedLogsAvailable: retainedLogs.has(app),
					};
				},
				async logs(
					app: string,
					tail: number,
					signal: AbortSignal,
					grep?: string,
					repository?: string,
				) {
					requireRepository(repository);
					if (!Number.isInteger(tail) || tail < 1 || tail > 1000)
						throw new OperationRefusal("operation-unavailable");
					if (
						grep !== undefined &&
						(grep.length < 1 || grep.length > 256 || grep.includes("\0"))
					)
						throw new OperationRefusal("operation-unavailable");
					const owned = session.releaseOwned(app);
					if (!owned.length) {
						const retained = retainedLogs.get(app);
						if (!retained) throw new OperationRefusal("operation-unavailable");
						return {
							app,
							tail,
							historical: true,
							retainedAt: retained.retainedAt,
							output: filterLogs(
								retained.output.split("\n").slice(-tail).join("\n"),
								grep,
							),
						};
					}
					const parts: string[] = [];
					const processOwned = owned.filter((item) => item.kind === "process");
					for (const item of processOwned) {
						const entry = processHandles.get(item.operation);
						if (entry) parts.push(redact(entry.handle.output()));
					}
					const helmOwned = owned.filter(
						(item) => item.kind === "helm-release",
					);
					const networkOwned = owned.filter((item) => item.kind === "network");
					const containerOwned = owned.filter(
						(item) => item.kind === "container",
					);
					if (!containerOwned.length && helmOwned.length)
						parts.push(
							"Native Helm chart workload logs are unavailable without a separately verified child diagnostic; the release itself is owned.",
						);
					if (
						!containerOwned.length &&
						!helmOwned.length &&
						networkOwned.length
					)
						parts.push(
							"An owned network-only target has no container logs; join it from a member and read that member's logs.",
						);
					if (containerOwned.length) {
						const first = containerOwned[0];
						if (!first) throw new OperationRefusal("operation-unavailable");
						parts.push(
							await executor.logs({
								containers: containerOwned.map((item) => item.runtimeId),
								socket: socketOf(first),
								provider: providerOf(first),
								tail,
								redact,
								signal,
							}),
						);
					}
					const output = parts.filter(Boolean).join("\n");
					if (!output && processOwned.length) {
						const retained = retainedLogs.get(app);
						if (retained)
							return {
								app,
								tail,
								historical: true,
								retainedAt: retained.retainedAt,
								output: filterLogs(
									retained.output.split("\n").slice(-tail).join("\n"),
									grep,
								),
							};
					}
					return {
						app,
						tail,
						historical: false,
						output: filterLogs(
							output.split("\n").slice(-tail).join("\n"),
							grep,
						),
					};
				},
				telemetry(app: string, traceId?: string, repository?: string) {
					requireRepository(repository);
					const receiver = telemetryByApp.get(app);
					if (!receiver) throw new OperationRefusal("operation-unavailable");
					return traceId
						? { app, trace: receiver.trace(traceId) }
						: receiver.snapshot();
				},
				async shutdown() {
					for (const { controller } of runs.values()) controller.abort();
					const owned = session.owned();
					const networkApps = new Set(
						owned
							.filter((entry) => entry.kind === "network")
							.map((entry) => entry.app),
					);
					const apps = [...new Set(owned.map((entry) => entry.app))].sort(
						(left, right) =>
							Number(networkApps.has(left)) - Number(networkApps.has(right)),
					);
					for (const app of apps)
						try {
							await this.stop(app, AbortSignal.timeout(10_000));
						} catch {
							/* Retain handles for a later stop or inspection. */
						}
					for (const { handle, telemetry } of processHandles.values()) {
						try {
							await handle.stop();
						} catch {
							/* Process identity remains inspection-only. */
						}
						telemetry?.close();
					}
					for (const receiver of telemetryByApp.values()) receiver.close();
					processHandles.clear();
				},
				closeScope(revision: number) {
					for (const { controller } of runs.values()) controller.abort();
					const repository = session.scope().workspace.directory;
					const closed = session.beginClose(revision);
					options.onEvent?.({ type: "status", repository });
					return closed;
				},
				finishClose(revision: number, cleaned: boolean) {
					const repository = session.scope().workspace.directory;
					const closed = session.finishClose(revision, cleaned);
					options.onEvent?.({ type: "status", repository });
					return closed;
				},
			};
		},
	};
}

export type ExecutionSession = ReturnType<
	ReturnType<typeof createExecutionService>["bind"]
>;
