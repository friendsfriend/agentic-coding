// Shared environment shapes are independent of catalog construction and adapter execution.
import type { ClusterInspection } from "./cluster-types.ts";
import type { ContainerTarget } from "./container-config.ts";
import type { EndpointAuth } from "./http-options.ts";
import type { KubernetesTarget } from "./kubernetes-config.ts";
import type { QueryConnection } from "./query-config.ts";
import type { Action } from "./selection.ts";
export type TelemetryOptions = {
	mode?: "traces" | "logs";
	view?: "flat" | "tree";
	cursor?: string;
	traceId?: string;
	spanId?: string;
	http?: string;
	service?: string;
	rootKind?: string;
	limit?: number;
	since?: string;
	status?: "all" | "error" | "success";
	name?: string;
	severity?: string;
	text?: string;
};
// Process consumers may read serialized observations, never control or recover a receiver.
export type TelemetryReader = {
	query(options: TelemetryOptions): Readonly<Record<string, unknown>>;
};
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
	condition:
		| "service_started"
		| "service_healthy"
		| "service_completed_successfully";
};
export type ComposePlan = {
	digest: string;
	services: {
		id: string;
		container: ContainerTarget;
		environment: Record<string, string>;
		secretRefs?: Record<string, string>;
		envFile?: string;
		envFileDigest?: string;
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
	/** Explicit Compose diagnostic selectors, never inferred from ports/order. */
	endpointServices?: Record<string, string>;
	queryService?: string;
	endpointCaRefs?: Record<string, string>;
	endpointAuthRefs?: Record<string, EndpointAuth>;
	queryConnection?: QueryConnection;
	telemetry?: { protocol: "otlp-http-json"; listen: "127.0.0.1:0" };
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
	lifetime?:
		| "independent-roots-v1"
		| "referenced-roots-v1"
		| "shared-prerequisites-v1";
	app: string;
	projectKind?: Project["kind"];
	requires?: string[];
	dependencyBatch?: boolean;
	workspace: string;
	cwd: string;
	composePlan?: ComposePlan;
	clusterConnection?: ClusterInspection;
};

/** Generation-bound observations, deliberately not a managed-reference lease. */
export type ReferenceObservation =
	| "reserved-observed"
	| "running-observed"
	| "closing-observed"
	| "settled-observed"
	| "interrupted-observed";
export type ReferenceGraph = {
	protocol: "native-root-reference-graph-v1";
	control: "coupled-observation-only";
	batch: string;
	owner: number;
	requestDigest: string;
	revision: number;
	createdAt: number;
	observation: ReferenceObservation;
	roots: {
		run: string;
		resources: string[];
		observation: ReferenceObservation;
	}[];
	members: {
		run: string;
		app: string;
		kind: Plan["projectKind"];
		planDigest: string;
		requires: string[];
	}[];
};
