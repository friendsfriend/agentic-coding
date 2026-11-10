import { object, text } from "../config.ts";
import { type HelmSpec, readHelm } from "./helm-chart.ts";
import { type ReadinessProbe, readReadinessProbe } from "./kubernetes-probe.ts";
/** Explicit chart release: never flattened into pods/Deployments and never an
 * upgrade of an existing release. Image/argv/env stay chart values. */
export type HelmTarget = {
	workload: "helm-release-v1";
	cluster: string;
	namespace: string;
	helm: HelmSpec;
	replicas?: undefined;
	portForwards?: undefined;
	services?: undefined;
};
export type KubernetesTarget = PodTarget | HelmTarget;
export type PodTarget = {
	/** Explicit controller protocol, never inferred from a chart or replica count. */
	workload?: "deployment-v1";
	helm?: undefined;
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
	/** Declared ClusterIP services selecting this run's pods by owner labels.
	 * In-cluster DNS only; host access still requires declared loopback forwards. */
	services?: { name: string; port: number; targetPort: number }[];
};
export function readKubernetes(raw: unknown): KubernetesTarget {
	const data = object(raw);
	if (data.workload === "helm-release-v1") {
		if (
			Object.keys(data).some(
				(key) => !["cluster", "workload", "namespace", "helm"].includes(key),
			)
		)
			throw new Error(
				"Helm release targets accept only cluster/workload/namespace/helm; image, argv, forwards, probes and services belong to the chart",
			);
		const cluster = text(data.cluster, "Kubernetes cluster identifier", 64),
			namespace = text(data.namespace, "Kubernetes namespace", 63);
		if (
			!/^[a-z][a-z0-9-]*$/.test(cluster) ||
			!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace) ||
			namespace.startsWith("kube-") ||
			namespace === "default"
		)
			throw new Error(
				"Choose an explicit non-system Kubernetes namespace and cluster identifier",
			);
		return {
			workload: "helm-release-v1",
			cluster,
			namespace,
			helm: readHelm(data.helm),
		};
	}
	if (
		Object.keys(data).some(
			(key) =>
				![
					"cluster",
					"workload",
					"namespace",
					"image",
					"command",
					"args",
					"replicas",
					"readinessProbe",
					"portForwards",
					"services",
				].includes(key),
		)
	)
		throw new Error(
			"Unsupported Kubernetes target field; only explicit native pod/Deployment targets with ClusterIP services are supported",
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
		throw new Error("Kubernetes pod/Deployment replicas must be from 1 to 16");
	if (data.workload !== undefined && data.workload !== "deployment-v1")
		throw new Error("Unsupported Kubernetes workload protocol");
	if (data.workload && data.portForwards !== undefined)
		throw new Error(
			"Deployment diagnostics cannot choose or follow controller pods implicitly; pod forwards remain refused",
		);
	const forwards = readPortForwards(data.portForwards, Number(replicas));
	const services = readServices(data.services);
	return {
		...(data.workload === "deployment-v1"
			? { workload: "deployment-v1" as const }
			: {}),
		cluster,
		namespace,
		image,
		command: argv(data.command),
		args: argv(data.args),
		replicas: Number(replicas),
		portForwards: forwards,
		services,
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

/** ClusterIP services only: DNS-label names, distinct service ports and no
 * type, clusterIP, external or headless overrides. The selector is always this
 * run's owner labels; nothing else chooses the backing pods. */
function readServices(raw: unknown) {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4)
		throw new Error("Kubernetes services require 1–4 declared entries");
	const services = raw.map((entry) => {
		const value = object(entry);
		if (
			Object.keys(value).some(
				(key) => !["name", "port", "targetPort"].includes(key),
			)
		)
			throw new Error(
				"Unsupported Kubernetes service field; only ClusterIP name/port/targetPort declarations are supported",
			);
		const name = text(value.name, "Kubernetes service name", 63);
		if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name))
			throw new Error(
				"Kubernetes service names must be DNS labels within the target namespace",
			);
		const port = (key: string) => {
			const selected = value[key];
			if (
				!Number.isSafeInteger(selected) ||
				Number(selected) < 1 ||
				Number(selected) > 65535
			)
				throw new Error("Kubernetes service ports must be 1–65535");
			return Number(selected);
		};
		return { name, port: port("port"), targetPort: port("targetPort") };
	});
	if (new Set(services.map((service) => service.name)).size !== services.length)
		throw new Error("Kubernetes services require distinct names");
	if (new Set(services.map((service) => service.port)).size !== services.length)
		throw new Error("Kubernetes services require distinct service ports");
	return services;
}
