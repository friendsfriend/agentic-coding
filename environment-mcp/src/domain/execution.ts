import * as z from "zod/v4";
import { action, identifier } from "../configuration/primitives.ts";

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
/** Container environment names follow the v2 Compose service-reference key
 * grammar; they are never used as host process environment names. */
const containerEnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/);
const commandName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);

export const commandExecutableSchema = z.strictObject({
	kind: z.literal("command"),
	program: z.string().min(1).max(4096),
	args: z
		.array(z.string().max(65536))
		.max(64)
		.refine(
			(args) =>
				args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) <=
				131072,
		)
		.default([]),
	env: z.record(envName, z.string().max(16000)).default({}),
	envRefs: z.record(envName, envName).default({}),
	timeoutSec: z.number().int().min(1).max(7200).default(600),
});

const loopbackReadiness = (value: string) => {
	try {
		const url = new URL(value);
		return (
			["http:", "https:"].includes(url.protocol) &&
			["127.0.0.1", "[::1]"].includes(url.hostname) &&
			!url.username &&
			!url.password &&
			!url.hash
		);
	} catch {
		return false;
	}
};

export const processExecutableSchema = z
	.strictObject({
		kind: z.literal("process"),
		program: z
			.string()
			.min(1)
			.max(4096)
			.refine((value) => value.startsWith("/")),
		args: z
			.array(z.string().max(65536))
			.max(64)
			.refine(
				(args) =>
					args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) <=
					131072,
			)
			.default([]),
		env: z.record(envName, z.string().max(16000)).default({}),
		envRefs: z.record(envName, envName).default({}),
		readyText: z.string().min(1).max(512).optional(),
		readyUrl: z.string().min(1).max(4096).refine(loopbackReadiness).optional(),
		telemetry: z.literal("otlp-http-json").optional(),
		timeoutSec: z.number().int().min(1).max(7200).default(300),
	})
	.refine((value) => !(value.readyText && value.readyUrl), {
		message: "Choose one process readiness signal",
	});

export const containerRunExecutableSchema = z.strictObject({
	kind: z.literal("container-run"),
	provider: z.enum(["docker", "podman"]).default("docker"),
	socket: z
		.string()
		.min(1)
		.max(4096)
		.refine((value) => value.startsWith("/")),
	image: z.string().min(1).max(512),
	name: z.string().regex(/^environment-mcp-[a-z0-9][a-z0-9_.-]{0,120}$/),
	ports: z
		.array(
			z.strictObject({
				host: z.number().int().min(1).max(65535),
				container: z.number().int().min(1).max(65535),
				address: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
			}),
		)
		.max(16)
		.default([]),
	env: z.record(envName, z.string().max(16000)).default({}),
	envRefs: z.record(envName, envName).default({}),
	readiness: z.enum(["running", "healthy"]).default("running"),
	/** External OTLP/HTTP JSON capture through the controller host gateway. */
	telemetry: z.literal("otlp-http-json").optional(),
	timeoutSec: z.number().int().min(1).max(7200).default(300),
});

export const composeExecutableSchema = z
	.strictObject({
		kind: z.literal("compose"),
		provider: z.enum(["docker", "podman"]).default("docker"),
		socket: z
			.string()
			.min(1)
			.max(4096)
			.refine((value) => value.startsWith("/")),
		file: z
			.string()
			.min(1)
			.max(4096)
			.refine((value) => value.startsWith("/"))
			.optional(),
		source: z.string().min(1).max(65536).optional(),
		project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
		services: z.array(commandName).min(1).max(16),
		readinessService: commandName.optional(),
		/** Compose interpolation references; these become the Compose process
		 * environment, never container environment automatically. */
		envRefs: z.record(envName, envName).default({}),
		/** Per-service container environment references. Resolved only at
		 * dispatch and injected through a private Compose override file. */
		serviceEnvRefs: z
			.record(commandName, z.record(containerEnvName, envName))
			.default({}),
		/** Compose collector telemetry is only valid for a selected collector
		 * service; the executor owns the live receiver identity. */
		telemetry: z
			.strictObject({
				protocol: z.literal("otlp-http-json"),
				collectorService: commandName,
				transport: z.literal("tls-host-gateway-v1"),
			})
			.optional(),
		/** Join a network created by an exact approved network-only target. The
		 * member never owns or removes that network. */
		networkFrom: z
			.strictObject({
				app: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
				target: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
				network: z
					.string()
					.regex(/^environment-mcp-[a-z0-9][a-z0-9_.-]{0,120}$/),
			})
			.optional(),
		timeoutSec: z.number().int().min(1).max(7200).default(300),
	})
	.refine((value) => Boolean(value.file) !== Boolean(value.source), {
		message: "Choose one Compose file source",
	})
	.refine(
		(value) =>
			!value.telemetry ||
			value.services.includes(value.telemetry.collectorService),
		{ message: "Telemetry collector must be a selected service" },
	);

export const networkOnlyExecutableSchema = z.strictObject({
	kind: z.literal("network-only"),
	provider: z.enum(["docker", "podman"]).default("docker"),
	socket: z
		.string()
		.min(1)
		.max(4096)
		.refine((value) => value.startsWith("/")),
	network: z.string().regex(/^environment-mcp-[a-z0-9][a-z0-9_.-]{0,120}$/),
	app: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	target: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	timeoutSec: z.number().int().min(1).max(7200).default(300),
});

export const dockerBuildExecutableSchema = z
	.strictObject({
		kind: z.literal("docker-build"),
		provider: z.enum(["docker", "podman"]).default("docker"),
		socket: z
			.string()
			.min(1)
			.max(4096)
			.refine((value) => value.startsWith("/")),
		context: z
			.string()
			.min(1)
			.max(4096)
			.refine((value) => value.startsWith("/")),
		dockerfile: z
			.string()
			.min(1)
			.max(4096)
			.refine((value) => value.startsWith("/"))
			.optional(),
		dockerfileSource: z.string().min(1).max(65536).optional(),
		image: z.string().min(1).max(512),
		secrets: z
			.array(
				z.discriminatedUnion("kind", [
					z.strictObject({
						kind: z.literal("template"),
						id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
						template: z.string().min(1).max(32768),
						encoding: z.enum(["xml", "text"]).default("text"),
						refs: z.record(envName, envName).default({}),
					}),
					z.strictObject({
						kind: z.literal("file"),
						id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
						file: z
							.string()
							.min(1)
							.max(4096)
							.refine((value) => value.startsWith("/")),
					}),
					z.strictObject({
						kind: z.literal("env"),
						id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
						env: envName,
					}),
				]),
			)
			.max(4)
			.default([]),
		timeoutSec: z.number().int().min(1).max(7200).default(3600),
	})
	.refine(
		(value) => Boolean(value.dockerfile) !== Boolean(value.dockerfileSource),
		{ message: "Choose one Dockerfile source" },
	);

export const helmReleaseExecutableSchema = z.strictObject({
	kind: z.literal("helm-release"),
	/** Cluster identifier and the immutable configuration digest resolved at
	 * dispatch; the kubeconfig itself never enters the plan or catalog. */
	cluster: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
	clusterDigest: z.string().regex(/^[a-f0-9]{64}$/),
	namespace: z
		.string()
		.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
		.refine((value) => !value.startsWith("kube-"), {
			message: "Kubernetes system namespaces are not supported",
		}),
	release: z
		.string()
		.max(53)
		.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
	chart: z
		.string()
		.min(1)
		.max(4096)
		.refine((value) => value.startsWith("/")),
	chartDigest: z.string().regex(/^[a-f0-9]{64}$/),
	values: z.array(z.string().min(1).max(4096)).max(8).default([]),
	setString: z
		.record(
			z
				.string()
				.regex(/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*){0,15}$/),
			z.string().max(1024),
		)
		.default({}),
	timeoutSec: z.number().int().min(1).max(7200).default(300),
});

export const executableSchema = z.discriminatedUnion("kind", [
	commandExecutableSchema,
	processExecutableSchema,
	containerRunExecutableSchema,
	composeExecutableSchema,
	networkOnlyExecutableSchema,
	dockerBuildExecutableSchema,
	helmReleaseExecutableSchema,
]);
export type Executable = z.output<typeof executableSchema>;

export const executionIntentSchema = z.strictObject({
	app: identifier,
	target: identifier,
	/** Canonical repository path when the same client is authorized for more
	 * than one repository. Omit only when the app identity is unambiguous. */
	repository: z.string().min(1).max(4096).optional(),
});
export type ExecutionIntent = z.output<typeof executionIntentSchema>;

export const executionDescriptorSchema = z.strictObject({
	action,
	executable: executableSchema,
	/** Exact approved run prerequisites. Only network-only prerequisites are
	 * auto-started today; other kinds remain explicit operations. */
	prerequisites: z
		.array(
			z.strictObject({
				app: identifier,
				target: identifier,
				executable: executableSchema,
			}),
		)
		.max(8)
		.default([]),
	/** Loopback application endpoints and their Compose service selectors. */
	endpoints: z.record(z.string(), z.string().max(4096)).default({}),
	endpointServices: z.record(z.string(), z.string()).default({}),
});
export type ExecutionDescriptor = z.output<typeof executionDescriptorSchema>;

export type ExecutionReceipt =
	| {
			status: "completed" | "failed";
			kind: "command";
			exitCode: number | null;
			timedOut: boolean;
			output: string;
			truncated: boolean;
	  }
	| {
			status: "completed" | "failed";
			kind: "docker-build";
			exitCode: number | null;
			timedOut: boolean;
			output: string;
			truncated: boolean;
			image: string;
	  }
	| {
			status: "completed" | "failed" | "starting";
			kind: "container";
			containerId: string;
			readiness: "ready" | "waiting" | "unknown";
			readinessSource:
				| "docker-health"
				| "docker-running"
				| "podman-health"
				| "podman-running";
			output: string;
			truncated: boolean;
	  }
	| {
			status: "completed" | "failed" | "starting";
			kind: "process";
			pid: number;
			readiness: "ready" | "failed";
			readinessSource: "process" | "text" | "endpoint";
			exitCode: number | null;
			output: string;
			truncated: boolean;
	  }
	| {
			status: "completed" | "failed" | "starting";
			kind: "compose";
			services: string[];
			containers: string[];
			readiness: "ready" | "waiting" | "unknown";
			/** What established readiness: application endpoint, engine health, or
			 * only the engine's running state. Running-only is not app health. */
			readinessSource:
				| "endpoint"
				| "docker-health"
				| "docker-running"
				| "podman-health"
				| "podman-running";
			endpoints?: {
				name: string;
				url: string;
				status: "ready" | "unreachable";
			}[];
			output: string;
			truncated: boolean;
	  }
	| {
			status: "completed" | "failed" | "starting";
			kind: "helm";
			release: string;
			namespace: string;
			deployments: string[];
			readiness: "ready" | "waiting" | "unknown";
			readinessSource: "helm-deployments";
			output: string;
			truncated: boolean;
	  }
	| {
			status: "completed" | "failed";
			kind: "network";
			networkId: string;
			name: string;
			readiness: "ready";
			readinessSource: "docker-network" | "podman-network";
			output: string;
			truncated: boolean;
	  };

export type ProcessHandle = {
	readonly pid: number;
	ready(signal: AbortSignal): Promise<boolean>;
	output(): string;
	exited(): boolean;
	exitCode(): number | null;
	stop(): Promise<boolean>;
};
export type ExecutionPort = {
	containerRun?(input: {
		executable: Extract<Executable, { kind: "container-run" }>;
		cwd: string;
		env: Record<string, string>;
		telemetry?: { certificate: string };
		signal: AbortSignal;
		redact: (value: string) => string;
	}): Promise<{
		containerId: string | null;
		output: string;
		timedOut: boolean;
		truncated: boolean;
	}>;
	processStart?(input: {
		executable: Extract<Executable, { kind: "process" }>;
		cwd: string;
		env: Record<string, string>;
		signal: AbortSignal;
	}): Promise<ProcessHandle>;
	command(input: {
		executable: Extract<Executable, { kind: "command" }>;
		cwd: string;
		env: Record<string, string>;
		redact: (value: string) => string;
		signal: AbortSignal;
	}): Promise<{
		exitCode: number | null;
		timedOut: boolean;
		output: string;
		truncated: boolean;
	}>;
	dockerBuild(input: {
		executable: Extract<Executable, { kind: "docker-build" }>;
		cwd: string;
		secrets: Record<string, string>;
		redact: (value: string) => string;
		signal: AbortSignal;
	}): Promise<{
		exitCode: number | null;
		timedOut: boolean;
		output: string;
		truncated: boolean;
	}>;
	composeUp(input: {
		executable: Extract<Executable, { kind: "compose" }>;
		cwd: string;
		env: Record<string, string>;
		serviceEnv?: Record<string, Record<string, string>>;
		serviceMounts?: Record<string, { source: string; target: string }[]>;
		redact: (value: string) => string;
		signal: AbortSignal;
	}): Promise<{
		exitCode: number | null;
		timedOut: boolean;
		output: string;
		truncated: boolean;
	}>;
	composeContainers(input: {
		executable: Extract<Executable, { kind: "compose" }>;
		cwd: string;
		env: Record<string, string>;
		signal: AbortSignal;
	}): Promise<string[]>;
	helmInstall?(input: {
		executable: Extract<Executable, { kind: "helm-release" }>;
		cluster: {
			context: string;
			kubeconfig?: string;
			environment: Record<string, string>;
		};
		runLabel: string;
		signal: AbortSignal;
		redact: (value: string) => string;
	}): Promise<{
		exitCode: number | null;
		timedOut: boolean;
		output: string;
		truncated: boolean;
		created?: {
			release: string;
			namespace: string;
			revision: number;
			label: string;
		};
		deployments: string[];
		readiness: "ready" | "waiting" | "unknown";
	}>;
	helmUninstall?(input: {
		executable: Extract<Executable, { kind: "helm-release" }>;
		cluster: {
			context: string;
			kubeconfig?: string;
			environment: Record<string, string>;
		};
		release: string;
		namespace: string;
		revision: number;
		label: string;
		signal: AbortSignal;
		redact: (value: string) => string;
	}): Promise<boolean>;
	networkCreate?(input: {
		executable: Extract<Executable, { kind: "network-only" }>;
		signal: AbortSignal;
		redact: (value: string) => string;
	}): Promise<{
		networkId: string | null;
		output: string;
		truncated: boolean;
	}>;
	networkInspect?(input: {
		socket: string;
		provider?: "docker" | "podman";
		name: string;
		signal: AbortSignal;
	}): Promise<{
		id: string;
		name: string;
		labels: Record<string, string>;
		containers: string[];
	} | null>;
	networkConnect?(input: {
		socket: string;
		provider?: "docker" | "podman";
		networkId: string;
		containers: string[];
		signal: AbortSignal;
	}): Promise<string[]>;
	networkRemove?(input: {
		socket: string;
		provider?: "docker" | "podman";
		networkId: string;
		name: string;
		signal: AbortSignal;
		redact: (value: string) => string;
	}): Promise<boolean>;
	containersReady(input: {
		socket: string;
		provider?: "docker" | "podman";
		containers: string[];
		requireHealth?: boolean;
		signal: AbortSignal;
	}): Promise<{
		readiness: "ready" | "waiting" | "unknown";
		source:
			| "docker-health"
			| "docker-running"
			| "podman-health"
			| "podman-running";
	}>;
	/** Application-level GET probes for configured loopback endpoints. */
	probeEndpoints?(input: {
		endpoints: { name: string; url: string }[];
		signal: AbortSignal;
	}): Promise<Record<string, "ready" | "unreachable">>;
	stopContainers(input: {
		containers: string[];
		socket: string;
		provider?: "docker" | "podman";
		signal: AbortSignal;
	}): Promise<string[]>;
	logs(input: {
		containers: string[];
		socket: string;
		provider?: "docker" | "podman";
		tail: number;
		redact: (value: string) => string;
		signal: AbortSignal;
	}): Promise<string>;
};
