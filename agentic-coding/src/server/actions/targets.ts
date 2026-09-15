// Internal environment resource model consumed by the action compilers
// (`port-action-execution-to-bun`, task 1.3).
//
// Ported from `server/pkg/resources/action_targets.go`,
// `server/pkg/resources/kubernetes_config.go` and the `KubernetesInfra` /
// `InfraService` shapes in `server/pkg/app/manager.go`.
//
// These are the runtime models, not the client DTOs: they carry the fields only
// the action compiler and executor read (`command`, `args`, `env`, `workingDir`,
// `provider`, the kubernetes release). The client-facing subset in
// `@devenv/types` (`ActionTarget`, `InfraService`) is structurally satisfied by
// these, so the routes can pass them through without a second mapping.
//
// Discovery (`DiscoverActionTargets`, the build/test/run probing of a checkout)
// lands with its own task; this module deliberately declares only what the
// compilers in `compile.ts` read today.

export type AppAction = "build" | "test" | "run";
export type ActionRuntime =
	| "docker"
	| "shell"
	| "powershell"
	| "systemshell"
	| "kubernetes";
export type ContainerProvider = "docker" | "podman";
export type LaunchMode = "logged" | "tmux";

export interface DependencyRef {
	app?: string;
	runtime?: string;
	profile?: string;
	provider?: ContainerProvider;
	lifecycle?: string;
	infra?: string;
}

export interface EndpointExport {
	name: string;
	protocol: string;
	host?: string;
	port: number;
	strategy: string;
	resource?: string;
	localPort?: number;
	readiness?: string;
}

export interface EndpointBinding {
	name: string;
	dependency?: string;
	export: string;
	destination: string;
	valuePath?: string;
}

export interface KubernetesImageValuePaths {
	repository?: string;
	tag?: string;
	pullPolicy?: string;
}

export interface KubernetesImageConfig {
	repository?: string;
	tag?: string;
	pullPolicy?: string;
	valuePaths?: KubernetesImageValuePaths;
}

export interface KubernetesSecretSummary {
	name: string;
	keys: string[];
}

export interface KubernetesPortForwardConfig {
	name?: string;
	resource: string;
	localPort: number;
	remotePort: number;
}

export interface KubernetesWaitConfig {
	enabled?: boolean;
	timeout?: string;
}

export interface KubernetesTargetMetadata {
	provider?: ContainerProvider;
	clusterName?: string;
	contextName?: string;
	chartPath: string;
	release: string;
	namespace?: string;
	valuesFiles?: string[];
	image?: KubernetesImageConfig;
	secrets?: KubernetesSecretSummary[];
	ports?: KubernetesPortForwardConfig[];
	wait?: KubernetesWaitConfig;
	exports?: EndpointExport[];
	bindings?: EndpointBinding[];
	sourcePath?: string;
}

export interface ActionTarget {
	id: string;
	action: AppAction;
	runtime: ActionRuntime;
	label: string;
	profile?: string;
	provider?: ContainerProvider;
	env?: Record<string, string>;
	launchMode?: LaunchMode;
	sourcePath: string;
	workingDir?: string;
	command?: string;
	args?: string[];
	requires?: DependencyRef[];
	exports?: EndpointExport[];
	bindings?: EndpointBinding[];
	kubernetes?: KubernetesTargetMetadata;
}

export interface KubernetesInfra {
	profile?: string;
	provider?: string;
	cluster?: string;
	context?: string;
	chartPath?: string;
	release?: string;
	namespace?: string;
	values?: string[];
	wait?: boolean;
	timeout?: string;
}

export interface InfraService {
	ident: string;
	displayName: string;
	type?: string;
	containerBaseName?: string;
	shellPath?: string;
	powerShellPath?: string;
	defaultRunner?: string;
	cwd?: string;
	args?: string[];
	env?: Record<string, string>;
	status?: string;
	logPath?: string;
	kubernetes?: KubernetesInfra;
}

export type InfraServiceType = "docker" | "script" | "kubernetes";
export type ScriptRunner = "shell" | "powershell";

export const INFRA_SERVICE_TYPE = {
	docker: "docker",
	script: "script",
	kubernetes: "kubernetes",
} as const;

export const SCRIPT_RUNNER = {
	shell: "shell",
	powershell: "powershell",
} as const;

/** Ported from `docker.ComposeCommandForRuntime`. */
export function composeCommandForRuntime(name: string): string {
	return name === "podman" ? "podman-compose" : "docker-compose";
}

/** Ported from `docker.RuntimeCommandForRuntime`. */
export function runtimeCommandForRuntime(name: string): string {
	return name === "podman" ? "podman" : "docker";
}

/** The two commands a compiler needs from the container runtime selection. */
export interface RuntimeCommands {
	composeCommand: string;
	runtimeCommand: string;
}

/**
 * The selected container runtime. Go keeps this as a package-level selection
 * (`docker.Runtime{Name, Command}`); the Bun side passes it in, so a compiler
 * stays a pure function of its inputs.
 */
export interface ContainerRuntimeSelection extends RuntimeCommands {
	name: string;
}

export const DEFAULT_CONTAINER_RUNTIME: ContainerRuntimeSelection = {
	name: "docker",
	composeCommand: composeCommandForRuntime("docker"),
	runtimeCommand: runtimeCommandForRuntime("docker"),
};

export interface KubernetesExecutionIdentity {
	provider: ContainerProvider;
	cluster: string;
	context: string;
}

/**
 * Ported from `kubernetes.ResolveIdentity`: a missing provider is docker, a
 * missing cluster is the legacy `devenv` identity and a missing context is
 * `kind-<cluster>`.
 */
export function resolveKubernetesIdentity(
	provider: ContainerProvider | undefined,
	cluster: string | undefined,
	context: string | undefined,
): KubernetesExecutionIdentity {
	return {
		provider: provider ?? "docker",
		cluster: cluster === undefined || cluster === "" ? "devenv" : cluster,
		context:
			context === undefined || context === ""
				? `kind-${cluster === undefined || cluster === "" ? "devenv" : cluster}`
				: context,
	};
}

/** Extra environment a `kind` invocation needs for a podman provider. */
export function kubernetesIdentityEnv(
	identity: KubernetesExecutionIdentity,
): string[] {
	return identity.provider === "podman"
		? ["KIND_EXPERIMENTAL_PROVIDER=podman"]
		: [];
}

/**
 * The tools whose presence decides which action variants exist. Missing tools
 * remove a variant instead of producing an action that cannot run.
 */
export interface ToolSet {
	docker?: boolean;
	podman?: boolean;
	dockerCompose?: boolean;
	podmanCompose?: boolean;
	tmux?: boolean;
	kind?: boolean;
	kubectl?: boolean;
	helm?: boolean;
}
