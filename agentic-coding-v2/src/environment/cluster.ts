import fs from "node:fs";
import path from "node:path";
import { type Config, digest, object, text } from "../config.ts";
import { contained } from "../git.ts";
import type { TaskInfo } from "../state.ts";
import type { Cluster, ClusterInspection } from "./cluster-types.ts";
import { EnvironmentCommands } from "./command.ts";
import type { Plan } from "./model.ts";
import { ShellProcess } from "./shell.ts";

function keys(data: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(data).some((key) => !allowed.includes(key)))
		throw new Error("Unsupported cluster configuration field");
}
function identifier(raw: unknown) {
	const value = text(raw, "cluster identifier", 64);
	if (!/^[a-z][a-z0-9-]*$/.test(value))
		throw new Error("Invalid cluster identifier");
	return value;
}
export function loadClusters(config: Config): Cluster[] {
	const file = path.join(config.configDir, "clusters.json");
	if (!fs.existsSync(file)) return [];
	try {
		const data = object(JSON.parse(fs.readFileSync(file, "utf8")));
		keys(data, ["version", "clusters"]);
		if (
			data.version !== 1 ||
			!Array.isArray(data.clusters) ||
			data.clusters.length > 16
		)
			throw new Error(
				"Cluster configuration needs version 1 and at most 16 clusters",
			);
		const clusters = data.clusters.map((raw) => {
			const entry = object(raw);
			keys(entry, ["id", "repository", "kubeconfig", "context", "environment"]);
			const repository = fs.realpathSync(
				text(entry.repository, "cluster repository", 4096),
			);
			if (!config.repositories.includes(repository))
				throw new Error("Cluster repository is not authorized");
			const environment = Object.fromEntries(
				Object.entries(object(entry.environment ?? {})).map(([key, value]) => {
					if (
						!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
						[
							"WORKSPACE",
							"CONFIG_DIR",
							"KUBECONFIG",
							"HTTP_PROXY",
							"HTTPS_PROXY",
							"ALL_PROXY",
							"NO_PROXY",
						].includes(key.toUpperCase()) ||
						key.toUpperCase().startsWith("HELM_") ||
						typeof value !== "string" ||
						value.includes("\0") ||
						value.length > 16000
					)
						throw new Error("Invalid cluster client environment");
					return [key, value];
				}),
			);
			return {
				id: identifier(entry.id),
				repository,
				kubeconfig: contained(
					fs.realpathSync(config.configDir),
					text(entry.kubeconfig, "explicit kubeconfig", 4096),
				),
				context: text(entry.context, "explicit Kubernetes context", 200),
				environment,
			};
		});
		if (new Set(clusters.map((cluster) => cluster.id)).size !== clusters.length)
			throw new Error("Duplicate cluster identifier");
		return clusters;
	} catch {
		throw new Error(
			"Invalid explicit cluster configuration; source values are private",
		);
	}
}
function source(file: string) {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > 65536) throw new Error();
		const bytes = Buffer.alloc(65537);
		let size = 0;
		while (size < bytes.length) {
			const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
			if (!count) break;
			size += count;
		}
		if (size > 65536) throw new Error();
		const content = bytes.subarray(0, size);
		return {
			digest: digest(content.toString("base64")),
			data: object(
				Bun.YAML.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(content),
				),
			),
		};
	} catch {
		throw new Error(
			"Private cluster configuration is unavailable or invalid; source values are not logged",
		);
	} finally {
		fs.closeSync(fd);
	}
}
function named(raw: unknown, name: string, key: string) {
	if (!Array.isArray(raw)) throw new Error();
	const matches = raw.map(object).filter((entry) => entry.name === name);
	if (matches.length !== 1) throw new Error();
	return object(matches[0]?.[key]);
}
/** Only a minimal, reference-only client configuration is supported. Never copy
 * inline credentials, exec plugins, auth providers or default context authority. */
export function prepareCluster(
	config: Config,
	owner: TaskInfo,
	cluster: Cluster,
): ClusterInspection {
	if (
		owner.policy !== "workspace-write" ||
		owner.repository !== cluster.repository
	)
		throw new Error(
			"Cluster inspection requires this repository's workspace-write task and separate human approval",
		);
	try {
		const input = source(cluster.kubeconfig),
			data = input.data;
		keys(data, [
			"apiVersion",
			"kind",
			"clusters",
			"contexts",
			"users",
			"current-context",
			"preferences",
		]);
		if (data.apiVersion !== "v1" || data.kind !== "Config") throw new Error();
		const context = named(data.contexts, cluster.context, "context");
		keys(context, ["cluster", "user", "namespace"]);
		const clusterName = text(context.cluster, "cluster name", 200),
			connection = named(data.clusters, clusterName, "cluster");
		keys(connection, ["server", "certificate-authority"]);
		const server = new URL(
			text(connection.server, "local Kubernetes server", 4096),
		);
		if (
			server.protocol !== "https:" ||
			!["127.0.0.1", "[::1]"].includes(server.hostname) ||
			server.username ||
			server.password ||
			server.search ||
			server.hash ||
			server.pathname !== "/"
		)
			throw new Error();
		const reference = (raw: unknown) =>
			contained(
				fs.realpathSync(config.configDir),
				path.relative(
					fs.realpathSync(config.configDir),
					path.resolve(
						path.dirname(cluster.kubeconfig),
						text(raw, "credential file reference", 4096),
					),
				),
			);
		const userName =
				context.user === undefined
					? "v2-no-auth"
					: text(context.user, "Kubernetes user", 200),
			user =
				context.user === undefined ? {} : named(data.users, userName, "user");
		keys(user, ["client-certificate", "client-key", "tokenFile"]);
		if (
			(user["client-certificate"] === undefined) !==
				(user["client-key"] === undefined) ||
			(user.tokenFile !== undefined && user["client-key"] !== undefined)
		)
			throw new Error();
		const publicUser = Object.fromEntries(
			Object.entries(user).map(([key, value]) => [key, reference(value)]),
		);
		const publicConnection = {
			server: server.origin,
			...(connection["certificate-authority"] === undefined
				? {}
				: {
						"certificate-authority": reference(
							connection["certificate-authority"],
						),
					}),
		};
		return {
			cluster,
			workspace: owner.workspace,
			sourceDigest: input.digest,
			server: server.origin,
			connection: {
				apiVersion: "v1",
				kind: "Config",
				clusters: [{ name: clusterName, cluster: publicConnection }],
				contexts: [
					{
						name: cluster.context,
						context: { cluster: clusterName, user: userName },
					},
				],
				users: [{ name: userName, user: publicUser }],
				"current-context": cluster.context,
			},
		};
	} catch {
		throw new Error(
			"Unsupported or unavailable explicit local kubeconfig. Require HTTPS on a numeric loopback address and config-contained credential file references; inline credentials, exec/auth plugins, proxies and insecure TLS are not supported. Source values are private.",
		);
	}
}
export function openClusterClient(
	config: Config,
	inspection: ClusterInspection,
) {
	// Revalidate config containment immediately before invoking the client; approval
	// of a reference is not permission to follow a newly external symlink.
	const root = fs.realpathSync(config.configDir),
		check = (file: unknown) =>
			contained(
				root,
				path.relative(
					root,
					text(file, "approved credential file reference", 4096),
				),
			);
	check(inspection.cluster.kubeconfig);
	for (const entry of inspection.connection.clusters) {
		const cluster = object(entry.cluster);
		if (cluster["certificate-authority"] !== undefined)
			check(cluster["certificate-authority"]);
	}
	for (const entry of inspection.connection.users)
		for (const file of Object.values(object(entry.user))) check(file);
	if (source(inspection.cluster.kubeconfig).digest !== inspection.sourceDigest)
		throw new Error(
			"Kubeconfig changed after approval; obtain a new exact cluster inspection approval",
		);
	fs.mkdirSync(config.stateDir, { recursive: true });
	const scratch = fs.mkdtempSync(
		path.join(config.stateDir, "cluster-inspection-"),
	);
	fs.chmodSync(scratch, 0o700);
	try {
		const file = path.join(scratch, "client.json");
		fs.writeFileSync(file, JSON.stringify(inspection.connection), {
			mode: 0o600,
		});
		const plan: Plan = {
			id: inspection.cluster.id,
			app: inspection.cluster.id,
			action: "run",
			runtime: "shell",
			command: "",
			workspace: inspection.workspace,
			cwd: inspection.workspace,
			timeoutMs: 10000,
			readyText: null,
			environment: inspection.cluster.environment,
			secretRefs: {},
		};
		const commands = new EnvironmentCommands(
			plan,
			config.configDir,
			"kubectl",
			[
				"--kubeconfig",
				file,
				"--context",
				inspection.cluster.context,
				"--server",
				inspection.server,
				"--request-timeout=8s",
			],
		);
		const helmHome = path.join(scratch, "helm");
		fs.mkdirSync(helmHome, { mode: 0o700 });
		// Helm state/plugins/repositories are private to this live client; the
		// developer's Helm home is never read and the release driver is fixed.
		const helm = new EnvironmentCommands(
			{
				...plan,
				environment: {
					...inspection.cluster.environment,
					HELM_CONFIG_HOME: path.join(helmHome, "config"),
					HELM_CACHE_HOME: path.join(helmHome, "cache"),
					HELM_DATA_HOME: path.join(helmHome, "data"),
					HELM_DRIVER: "secret",
					HELM_NO_PLUGINS: "1",
				},
			},
			config.configDir,
			"helm",
			[
				"--kubeconfig",
				file,
				"--kube-context",
				inspection.cluster.context,
				"--kube-apiserver",
				inspection.server,
			],
		);
		return {
			commands,
			helm,
			/** One declared loopback port forward to an owned pod; a local client
			 * process, never a readiness, ownership or endpoint authority. */
			forward: (
				namespace: string,
				name: string,
				local: number,
				remote: number,
			) =>
				new ShellProcess({ ...plan, timeoutMs: 7200000 }, config.configDir, {
					executable: "kubectl",
					args: [
						"--kubeconfig",
						file,
						"--context",
						inspection.cluster.context,
						"--server",
						inspection.server,
						"port-forward",
						"--address",
						"127.0.0.1",
						"--namespace",
						namespace,
						`pod/${name}`,
						`${local}:${remote}`,
					],
				}),
			/** One bounded, timestamped pod log follower; never a control channel. */
			follow: (namespace: string, name: string) =>
				new ShellProcess({ ...plan, timeoutMs: 7200000 }, config.configDir, {
					executable: "kubectl",
					args: [
						"--kubeconfig",
						file,
						"--context",
						inspection.cluster.context,
						"--server",
						inspection.server,
						"logs",
						"--follow",
						"--timestamps",
						"--tail",
						"200",
						"--namespace",
						namespace,
						name,
					],
					runtimeTimestamps: true,
				}),
			close: () => {
				if (!commands.cleanupFailed && !helm.cleanupFailed)
					fs.rmSync(scratch, { recursive: true, force: true });
			},
		};
	} catch (error) {
		fs.rmSync(scratch, { recursive: true, force: true });
		throw error;
	}
}
export async function inspectCluster(
	config: Config,
	inspection: ClusterInspection,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const client = openClusterClient(config, inspection);
	try {
		const raw = await client.commands.checked(
			["get", "namespace", "kube-system", "-o", "json"],
			{ timeoutMs: 10000, signal, machine: true },
		);
		let uid: string;
		try {
			const resource = object(JSON.parse(raw)),
				metadata = object(resource.metadata);
			if (
				resource.kind !== "Namespace" ||
				metadata.name !== "kube-system" ||
				typeof metadata.uid !== "string" ||
				!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
					metadata.uid,
				)
			)
				throw new Error();
			uid = metadata.uid;
		} catch {
			throw new Error(
				"Invalid private Kubernetes identity observation; API status is unverified",
			);
		}
		return {
			cluster: inspection.cluster.id,
			context: inspection.cluster.context,
			server: inspection.server,
			status: "api-reachable",
			clusterUid: uid,
			observedAt: Date.now(),
			scope:
				"Read-only kube-system namespace identity; not workload readiness or cleanup/adoption authority",
		};
	} finally {
		client.close();
	}
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
	reservedNamespace = /^(default|kube-.*)$/;
/** Operator namespaces are DNS labels outside the reserved system set. An
 * existing namespace is never adopted: creation reports the API's own
 * refusal, and deletion of a missing namespace reports the API's own miss. */
export function namespaceName(raw: unknown) {
	const name = text(raw, "cluster namespace", 63);
	if (
		!/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ||
		reservedNamespace.test(name)
	)
		throw new Error(
			"Cluster namespaces must be DNS labels outside the reserved system set (default, kube-*)",
		);
	return name;
}
/** Explicit operator-approved namespace creation. Approval of the reference
 * never invents the namespace: an existing name fails at the API. */
export async function createClusterNamespace(
	config: Config,
	inspection: ClusterInspection,
	namespace: string,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const client = openClusterClient(config, inspection);
	try {
		const raw = await client.commands.checked(
			["create", "namespace", namespace, "-o", "json"],
			{ timeoutMs: 15000, signal, machine: true },
		);
		try {
			const resource = object(JSON.parse(raw)),
				metadata = object(resource.metadata);
			if (
				resource.kind !== "Namespace" ||
				metadata.name !== namespace ||
				typeof metadata.uid !== "string" ||
				!uuid.test(metadata.uid)
			)
				throw new Error();
			return {
				cluster: inspection.cluster.id,
				namespace,
				status: "created",
				namespaceUid: metadata.uid,
				observedAt: Date.now(),
				scope:
					"Explicitly approved namespace creation; an existing name fails at the API and is never adopted",
			};
		} catch {
			throw new Error(
				"Invalid private Kubernetes namespace observation; creation is unverified",
			);
		}
	} catch (error) {
		if (
			error instanceof Error &&
			/changed after approval|Unsupported or unavailable explicit local kubeconfig/.test(
				error.message,
			)
		)
			throw error;
		throw new Error(
			"Kubernetes namespace creation failed; an existing namespace is never adopted",
		);
	} finally {
		client.close();
	}
}
/** Explicit operator-approved namespace deletion. Deleting a missing
 * namespace fails at the API; reserved system namespaces never reach it. */
export async function deleteClusterNamespace(
	config: Config,
	inspection: ClusterInspection,
	namespace: string,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const client = openClusterClient(config, inspection);
	try {
		const raw = await client.commands.checked(
			["delete", "namespace", namespace, "-o", "json"],
			{ timeoutMs: 15000, signal, machine: true },
		);
		try {
			const status = object(JSON.parse(raw));
			if (status.kind !== "Status" || status.status !== "Success")
				throw new Error();
			return {
				cluster: inspection.cluster.id,
				namespace,
				status: "deleted",
				observedAt: Date.now(),
				scope:
					"Explicitly approved namespace deletion; a missing namespace fails at the API",
			};
		} catch {
			throw new Error(
				"Invalid private Kubernetes deletion observation; deletion is unverified",
			);
		}
	} catch (error) {
		if (
			error instanceof Error &&
			/changed after approval|Unsupported or unavailable explicit local kubeconfig/.test(
				error.message,
			)
		)
			throw error;
		throw new Error(
			"Kubernetes namespace deletion failed; a missing namespace is never treated as deleted",
		);
	} finally {
		client.close();
	}
}
