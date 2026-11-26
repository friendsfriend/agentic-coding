export type KubernetesClusterInfo = {
	id: string;
	context: string;
	repositories: readonly string[];
};

export type KubernetesResource = {
	kind: string;
	name: string;
	status: string;
	ready?: string;
	restarts?: number;
	containers?: readonly string[];
	age?: string;
	createdAt?: string;
};

export type KubernetesResources = {
	cluster: string;
	namespace: string;
	output: string;
	truncated: boolean;
	items: readonly KubernetesResource[];
};

export type KubernetesEvent = {
	type: string;
	reason: string;
	object: string;
	message: string;
	count?: number;
	lastTimestamp?: string;
};

export type KubernetesNamespaces = {
	cluster: string;
	namespaces: readonly string[];
};

export type KubernetesEvents = {
	cluster: string;
	namespace: string;
	output: string;
	truncated: boolean;
	events: readonly KubernetesEvent[];
};

export type KubernetesDescribe = {
	cluster: string;
	namespace: string;
	kind: string;
	name: string;
	output: string;
	truncated: boolean;
};

export type KubernetesPodLogs = {
	cluster: string;
	namespace: string;
	pod: string;
	container?: string;
	previous?: boolean;
	output: string;
	truncated: boolean;
};

export interface KubernetesPort {
	list(repositories: readonly string[]): readonly KubernetesClusterInfo[];
	resources(
		repositories: readonly string[],
		cluster: string,
		namespace: string,
		signal: AbortSignal,
	): Promise<KubernetesResources>;
	namespaces(
		repositories: readonly string[],
		cluster: string,
		signal: AbortSignal,
	): Promise<KubernetesNamespaces>;
	events(
		repositories: readonly string[],
		cluster: string,
		namespace: string,
		signal: AbortSignal,
	): Promise<KubernetesEvents>;
	describe(
		repositories: readonly string[],
		cluster: string,
		namespace: string,
		kind: string,
		name: string,
		signal: AbortSignal,
	): Promise<KubernetesDescribe>;
	podLogs(
		repositories: readonly string[],
		cluster: string,
		namespace: string,
		pod: string,
		container: string | undefined,
		tail: number,
		previous: boolean,
		signal: AbortSignal,
	): Promise<KubernetesPodLogs>;
}
