import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const clusterId = /^[a-z][a-z0-9-]{0,63}$/;
const contextName = /^[A-Za-z0-9_.:/-]{1,200}$/;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const forbiddenEnvironment = new Set([
	"WORKSPACE",
	"CONFIG_DIR",
	"KUBECONFIG",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
]);
const MAX_KUBECONFIG = 256 * 1024;

export type KubernetesCluster = {
	id: string;
	context: string;
	kubeconfig?: string;
	environment: Record<string, string>;
	digest: string;
};

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const text = (value: unknown) =>
	typeof value === "string" ? value : undefined;

function clusterEnvironment(raw: unknown) {
	const data = object(raw ?? {});
	if (Object.keys(data).length > 32)
		throw new Error("Kubernetes cluster environment is too large");
	return Object.fromEntries(
		Object.entries(data).map(([key, value]) => {
			const upper = key.toUpperCase();
			if (
				!envName.test(key) ||
				forbiddenEnvironment.has(upper) ||
				upper.startsWith("HELM_") ||
				typeof value !== "string" ||
				value.includes("\0") ||
				value.length > 16000
			)
				throw new Error("Invalid Kubernetes cluster environment");
			return [key, value];
		}),
	);
}

function kubeconfig(configDir: string, raw: unknown) {
	const declared = text(raw);
	if (!declared) throw new Error("Kubernetes clusters require a kubeconfig");
	const resolved = path.resolve(configDir, declared);
	const canonical = fs.realpathSync(resolved);
	if (!resolved.startsWith(`${configDir}${path.sep}`) && resolved !== configDir)
		throw new Error("Kubernetes kubeconfig must be inside the config root");
	const stat = fs.lstatSync(canonical);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("Kubernetes kubeconfig must be a regular file");
	const fd = fs.openSync(
		canonical,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.size > MAX_KUBECONFIG)
			throw new Error("Kubernetes kubeconfig is too large");
		const bytes = fs.readFileSync(fd);
		return {
			path: canonical,
			digest: digest(bytes.toString("base64")),
		};
	} finally {
		fs.closeSync(fd);
	}
}

/** Read the explicit v2 clusters.json shape. The v1 shared `devenv` cluster is
 * the implicit fallback with context `kind-devenv`; this package does not
 * provision kind or rewrite a kubeconfig. Provisioned cluster entries are
 * refused rather than claiming a cluster it did not create. */
export function loadKubernetesClusters(
	configDir: string,
	repositories: readonly string[],
): Map<string, KubernetesCluster> {
	const root = fs.realpathSync(configDir);
	const file = path.join(root, "clusters.json");
	const clusters = new Map<string, KubernetesCluster>();
	if (fs.existsSync(file)) {
		const raw = object(JSON.parse(fs.readFileSync(file, "utf8")));
		const entries = Array.isArray(raw.clusters) ? raw.clusters : [];
		if (raw.version !== 1 || entries.length > 16)
			throw new Error("Invalid clusters.json version or count");
		for (const entry of entries.map(object)) {
			if (entry.provision !== undefined)
				throw new Error(
					"Kubernetes cluster provisioning is not supported by this package",
				);
			const id = text(entry.id);
			const context = text(entry.context);
			if (!id || !clusterId.test(id) || !context || !contextName.test(context))
				throw new Error("Invalid Kubernetes cluster identity");
			if (clusters.has(id))
				throw new Error("Duplicate Kubernetes cluster identifier");
			const declared =
				entry.repositories === undefined
					? [entry.repository]
					: entry.repositories;
			if (
				!Array.isArray(declared) ||
				!declared.length ||
				declared.length > 64 ||
				declared.some(
					(repository) =>
						typeof repository !== "string" ||
						!repositories.includes(fs.realpathSync(repository)),
				)
			)
				throw new Error("Kubernetes cluster repository is not authorized");
			const environment = clusterEnvironment(entry.environment);
			const selected = kubeconfig(root, entry.kubeconfig);
			clusters.set(id, {
				id,
				context,
				kubeconfig: selected.path,
				environment,
				digest: digest(
					JSON.stringify({
						id,
						context,
						kubeconfig: selected.digest,
						environment,
					}),
				),
			});
		}
	}
	if (!clusters.has("devenv") && repositories.length) {
		const environment = {};
		clusters.set("devenv", {
			id: "devenv",
			context: "kind-devenv",
			environment,
			digest: digest(JSON.stringify({ id: "devenv", context: "kind-devenv" })),
		});
	}
	return clusters;
}

export function clusterConnection(
	configDir: string,
	repositories: readonly string[],
	id: string,
	expectedDigest: string,
) {
	const cluster = loadKubernetesClusters(configDir, repositories).get(id);
	if (!cluster) throw new Error("kubernetes-cluster-unavailable");
	if (cluster.digest !== expectedDigest)
		throw new Error("kubernetes-cluster-changed");
	return cluster;
}
