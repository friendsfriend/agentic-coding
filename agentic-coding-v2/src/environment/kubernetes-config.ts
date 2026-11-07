import { object, text } from "../config.ts";
import { type ReadinessProbe, readReadinessProbe } from "./kubernetes-probe.ts";
export type KubernetesTarget = {
	cluster: string;
	namespace: string;
	image: string;
	command: string[];
	args: string[];
	replicas: number;
	readinessProbe?: ReadinessProbe;
	/** Declared loopback-only pod port forwards; never a readiness signal. Every
	 * forward pins exactly one replica the operator approved. */
	portForwards?: { local: number; remote: number; replica: number }[];
};
export function readKubernetes(raw: unknown): KubernetesTarget {
	const data = object(raw);
	if (
		Object.keys(data).some(
			(key) =>
				![
					"cluster",
					"namespace",
					"image",
					"command",
					"args",
					"replicas",
					"readinessProbe",
					"portForwards",
				].includes(key),
		)
	)
		throw new Error(
			"Unsupported Kubernetes target field; only bare pod targets are supported",
		);
	const cluster = text(data.cluster, "Kubernetes cluster identifier", 64),
		namespace = text(data.namespace, "Kubernetes namespace", 63),
		image = text(data.image, "Kubernetes image", 4096);
	if (
		!/^[a-z][a-z0-9-]*$/.test(cluster) ||
		!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace) ||
		namespace.startsWith("kube-") ||
		namespace === "default"
	)
		throw new Error(
			"Choose an explicit non-system Kubernetes namespace and cluster identifier",
		);
	const argv = (value: unknown) => {
		if (value === undefined) return [];
		if (!Array.isArray(value) || value.length > 64)
			throw new Error("Kubernetes commands require bounded argv arrays");
		return value.map((part) => text(part, "Kubernetes argv", 16000));
	};
	const replicas = data.replicas ?? 1;
	if (
		!Number.isSafeInteger(replicas) ||
		Number(replicas) < 1 ||
		Number(replicas) > 16
	)
		throw new Error("Kubernetes bare pod replicas must be from 1 to 16");
	const forwards = readPortForwards(data.portForwards, Number(replicas));
	return {
		cluster,
		namespace,
		image,
		command: argv(data.command),
		args: argv(data.args),
		replicas: Number(replicas),
		portForwards: forwards,
		...(data.readinessProbe === undefined
			? {}
			: { readinessProbe: readReadinessProbe(data.readinessProbe) }),
	};
}

/** Loopback-only forwards with unique local ports: no bind address, DNS or
 * allocation is inferred, and a duplicate local port is refused. Every forward
 * pins exactly one replica: several replicas require an explicit selection the
 * operator approved, and a single replica names no selection. */
function readPortForwards(raw: unknown, replicas: number) {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8)
		throw new Error("Kubernetes port forwards require 1–8 declared entries");
	const forwards = raw.map((entry) => {
		const value = object(entry);
		if (
			Object.keys(value).some(
				(key) => !["local", "remote", "replica"].includes(key),
			)
		)
			throw new Error("Unsupported Kubernetes port forward field");
		const port = (key: string) => {
			const selected = value[key];
			if (
				!Number.isSafeInteger(selected) ||
				Number(selected) < 1 ||
				Number(selected) > 65535
			)
				throw new Error("Kubernetes port forward ports must be 1–65535");
			return Number(selected);
		};
		const replica = value.replica;
		if (replicas === 1 && replica !== undefined)
			throw new Error(
				"Kubernetes port forwards name no pod selection for a single replica",
			);
		if (
			replicas > 1 &&
			(!Number.isSafeInteger(replica) ||
				Number(replica) < 0 ||
				Number(replica) >= replicas)
		)
			throw new Error(
				"Kubernetes port forwards require exactly one replica selection within the replica count: a pod is not chosen implicitly",
			);
		return {
			local: port("local"),
			remote: port("remote"),
			replica: replica === undefined ? 0 : Number(replica),
		};
	});
	if (
		new Set(forwards.map((forward) => forward.local)).size !== forwards.length
	)
		throw new Error("Kubernetes port forwards require distinct local ports");
	return forwards;
}
