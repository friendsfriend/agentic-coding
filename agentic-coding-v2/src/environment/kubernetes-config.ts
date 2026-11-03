import { object, text } from "../config.ts";
export type KubernetesTarget = {
	cluster: string;
	namespace: string;
	image: string;
	command: string[];
	args: string[];
	replicas: number;
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
	return {
		cluster,
		namespace,
		image,
		command: argv(data.command),
		args: argv(data.args),
		replicas: Number(replicas),
	};
}
