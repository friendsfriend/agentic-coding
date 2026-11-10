// Shared environment shapes are independent of catalog construction and adapter execution.
import type { ClusterRequest } from "./cluster-types.ts";
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
	/** Config-owned captured bytes; file is a virtual workspace-relative bind base. */
	source?: string;
	provider: "docker" | "podman";
	socket: string;
	network: "shared" | "isolated";
	/** Explicit infrastructure-only topology owner; no fabricated keeper service. */
	networkOnly?: true;
	/** Exact declared infrastructure prerequisite; never a network name or saved ID. */
	networkFrom?: { app: string; target: string };
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
	volumes?: import("./compose-volumes.ts").PlannedVolume[];
	services: {
		id: string;
		container: ContainerTarget;
		environment: Record<string, string>;
		secretRefs?: Record<string, string>;
		volumeMounts?: { id: string; target: string; readOnly: boolean }[];
		envFile?: string;
		envFileDigest?: string;
		dependsOn: ComposeDependency[];
	}[];
};

export type Target = {
	id: string;
	action: Action;
	runtime:
		| "shell"
		| "systemshell"
		| "docker"
		| "podman"
		| "compose"
		| "kubernetes";
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
	readyUrl?: string;
	environment: Record<string, string>;
	secretRefs: Record<string, string>;
	endpoints?: Record<string, string>;
	/** Explicit Compose diagnostic selectors, never inferred from ports/order. */
	endpointServices?: Record<string, string>;
	queryService?: string;
	endpointCaRefs?: Record<string, string>;
	endpointAuthRefs?: Record<string, EndpointAuth>;
	queryConnection?: QueryConnection;
	telemetry?:
		| { protocol: "otlp-http-json"; listen: "127.0.0.1:0" }
		| {
				protocol: "otlp-http-json";
				listen: "0.0.0.0:0";
				collectorService: string;
				transport: "tls-host-gateway-v1";
		  };
	prerequisites?: { app: string; target: string }[];
};
export type Project = {
	id: string;
	kind: "app" | "library" | "infrastructure";
	repository: string;
	targets: Target[];
	requires?: string[];
	/** Explicit target-scoped app/infrastructure prerequisites, including authorized foreign repositories. */
	prerequisites?: { app: string; target: string }[];
	defaults?: Partial<Record<Action, string>>;
};
export type Plan = Target & {
	lifetime?:
		| "independent-roots-v1"
		| "referenced-roots-v1"
		| "shared-prerequisites-v1"
		| "operator-infrastructure-v1"
		| "operator-infrastructure-v2"
		| "operator-infrastructure-v3";
	/** Derived only from the protected operator's exact requested units, never configuration input. */
	operatorRoot?: true;
	/** Derived only for an explicitly reviewed persistent v3 topology, never target input. */
	operatorAnchor?: true;
	/** Native re-add review pins the already-live original topology; never config input. */
	operatorTopology?: string;
	app: string;
	projectKind?: Project["kind"];
	requires?: string[];
	/** Explicit target identity for edges beyond the legacy same-repository infrastructure graph. */
	prerequisiteTargets?: Record<string, string>;
	dependencyWorkspace?: import("./dependency-workspaces.ts").DependencyWorkspace;
	dependencyBatch?: boolean;
	workspace: string;
	cwd: string;
	composePlan?: ComposePlan;
	/** Approval-time chart identity; derived only, never configuration input. */
	helmChart?: import("./helm-chart.ts").HelmChartCapture;
	clusterConnection?: ClusterRequest;
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

/** POSIX process adapters share native ownership/readiness, not interpreter
 * selection: shell pins /bin/sh; systemshell resolves sh in approved PATH. */
export function isShellRuntime(
	runtime: unknown,
): runtime is "shell" | "systemshell" {
	return runtime === "shell" || runtime === "systemshell";
}
