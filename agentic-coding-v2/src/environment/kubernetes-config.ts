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
	/** Declared loopback-only pod port forwards; never a readiness signal. */
	portForwards?: { local: number; remote: number }[];
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
	const forwards = readPortForwards(data.portForwards),
		replicas = data.replicas ?? 1;
	if (
		!Number.isSafeInteger(replicas) ||
		Number(replicas) < 1 ||
		Number(replicas) > 16
	)
		throw new Error("Kubernetes bare pod replicas must be from 1 to 16");
	// A forward targets one pod; several replicas would need a selection the
	// operator never approved.
	if (Number(replicas) > 1 && forwards.length)
		throw new Error(
			"Kubernetes port forwards require exactly one replica: a pod is not chosen implicitly",
		);
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
 * allocation is inferred, and a duplicate local port is refused. */
function readPortForwards(raw: unknown) {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8)
		throw new Error("Kubernetes port forwards require 1–8 declared entries");
	const forwards = raw.map((entry) => {
		const value = object(entry);
		if (Object.keys(value).some((key) => !["local", "remote"].includes(key)))
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
		return { local: port("local"), remote: port("remote") };
	});
	if (
		new Set(forwards.map((forward) => forward.local)).size !== forwards.length
	)
		throw new Error("Kubernetes port forwards require distinct local ports");
	return forwards;
}
