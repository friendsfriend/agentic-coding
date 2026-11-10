export type Cluster = {
	id: string;
	/** Repositories whose tasks may use this cluster (v1's shared kind cluster
	 * served every app). Each must be an authorized repository. */
	repositories: string[];
	kubeconfig: string;
	context: string;
	environment: Record<string, string>;
	/** v1's implicit kind cluster: created on first use when missing, reused
	 * when present, never deleted or recreated by a run. Its kubeconfig is
	 * materialized privately from `kind get kubeconfig` at connection time. */
	provision?: { tool: "kind"; name: string; provider: "docker" | "podman" };
};
/** A provisioned cluster's approved reference: the connection is resolved
 * (and the cluster created if missing) only when a run or operation starts. */
export type ProvisionedCluster = {
	cluster: Cluster & { provision: NonNullable<Cluster["provision"]> };
	workspace: string;
	provision: NonNullable<Cluster["provision"]>;
};
/** Reference-only client data: credential bytes never belong to an approved plan. */
export type ClusterInspection = {
	cluster: Cluster;
	sourceDigest: string;
	server: string;
	workspace: string;
	connection: {
		apiVersion: "v1";
		kind: "Config";
		clusters: {
			name: string;
			cluster: { server: string; "certificate-authority"?: string };
		}[];
		contexts: { name: string; context: { cluster: string; user: string } }[];
		users: {
			name: string;
			user: Partial<
				Record<"client-certificate" | "client-key" | "tokenFile", string>
			>;
		}[];
		"current-context": string;
	};
};
export type ClusterRequest = ClusterInspection | ProvisionedCluster;
