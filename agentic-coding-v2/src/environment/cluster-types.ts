export type Cluster = {
	id: string;
	/** Repositories whose tasks may use this cluster (v1's shared kind cluster
	 * served every app). Each must be an authorized repository. */
	repositories: string[];
	kubeconfig: string;
	context: string;
	environment: Record<string, string>;
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
