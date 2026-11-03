// Shared environment shapes are independent of catalog construction and adapter execution.
import type { ClusterInspection } from "./cluster-types.ts";
import type { ContainerTarget } from "./container-config.ts";
import type { EndpointAuth } from "./http-options.ts";
import type { KubernetesTarget } from "./kubernetes-config.ts";
import type { QueryConnection } from "./query-config.ts";
import type { Action } from "./selection.ts";
export type Availability = {
	eligible: boolean | null;
	reason: string;
	probe: "not-performed";
	executable?: string;
};

export type ComposeDefinition = {
	file: string;
	provider: "docker" | "podman";
	socket: string;
	network: "shared" | "isolated";
};
export type ComposeDependency = {
	id: string;
	condition: "service_started" | "service_healthy";
};
export type ComposePlan = {
	digest: string;
	services: {
		id: string;
		container: ContainerTarget;
		environment: Record<string, string>;
		dependsOn: ComposeDependency[];
	}[];
};

export type Target = {
	id: string;
	action: Action;
	runtime: "shell" | "docker" | "podman" | "compose" | "kubernetes";
	kubernetes?: KubernetesTarget;
	container?: ContainerTarget;
	compose?: ComposeDefinition;
	availability?: Availability;
	command: string;
	profile?: string;
	label?: string;
	cwd: string;
	timeoutMs: number;
	readyText: string | null;
	environment: Record<string, string>;
	secretRefs: Record<string, string>;
	endpoints?: Record<string, string>;
	endpointCaRefs?: Record<string, string>;
	endpointAuthRefs?: Record<string, EndpointAuth>;
	queryConnection?: QueryConnection;
};
export type Project = {
	id: string;
	kind: "app" | "library" | "infrastructure";
	repository: string;
	targets: Target[];
	requires?: string[];
	defaults?: Partial<Record<Action, string>>;
};
export type Plan = Target & {
	app: string;
	projectKind?: Project["kind"];
	requires?: string[];
	dependencyBatch?: boolean;
	workspace: string;
	cwd: string;
	composePlan?: ComposePlan;
	clusterConnection?: ClusterInspection;
};
