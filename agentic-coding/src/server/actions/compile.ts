// Definition compilers for the environment action families that are pure
// configuration transforms (`port-action-execution-to-bun`, task 1.3).
//
// Ported from `server/pkg/actionregistry/{git,docker_lifecycle,infrastructure,
// kubernetes,kubernetes_lifecycle,kubernetes_validation}.go`.
//
// Each compiler turns configured resources into immutable definitions; nothing
// here touches the filesystem, the network or the process table, so the output
// is a function of its inputs and is pinned by the golden fixture in
// `test/fixtures/actions/definitions.json`. Target discovery and the
// target-driven compiler (`CompileTargetGraph`) are a separate, I/O-owning step.
//
// Definitions are emitted with Go's encoding/json omitempty semantics
// (empty arrays, empty maps, empty strings and `false` optional fields are
// absent) because the same object is served verbatim by
// `GET /api/action-definition`.

import path from "node:path";
import type {
	ActionDefinition,
	ActionInputDefinition,
	ActionResourceRef,
	ActionStepDefinition,
	ActionStepKind,
	ActionValuePort,
} from "@devenv/types";
import { resourceActionId, stepId } from "./identity.ts";
import {
	type ActionTarget,
	type ContainerProvider,
	composeCommandForRuntime,
	INFRA_SERVICE_TYPE,
	type InfraService,
	type KubernetesExecutionIdentity,
	type KubernetesTargetMetadata,
	kubernetesIdentityEnv,
	resolveKubernetesIdentity,
	SCRIPT_RUNNER,
	type ToolSet,
} from "./targets.ts";

const KIND: Record<string, ActionStepKind> = {
	composite: "composite",
	command: "command",
	process: "process",
	readiness: "readiness",
	operation: "operation",
	cleanup: "cleanup",
} as const;

const SCOPE_ACTION = "action";
const VISIBILITY_PUBLIC = "public";
const VISIBILITY_INTERNAL = "internal";

interface StepInit {
	id: string;
	kind: ActionStepKind;
	label: string;
	children?: ActionStepDefinition[];
	condition?: "always" | "on-success" | "on-failure";
	failurePolicy?: "stop" | "continue" | "always-run";
	consumes?: ActionValuePort[];
	produces?: ActionValuePort[];
	handler?: string;
	configuration?: Record<string, unknown>;
}

/** Builds a step with Go's `omitempty` behaviour for absent optional fields. */
function makeStep(init: StepInit): ActionStepDefinition {
	const step = {
		id: init.id,
		kind: init.kind,
		label: init.label,
	} as ActionStepDefinition & Record<string, unknown>;
	if (init.children && init.children.length > 0) step.children = init.children;
	if (init.condition) step.condition = init.condition;
	if (init.failurePolicy) step.failurePolicy = init.failurePolicy;
	if (init.consumes && init.consumes.length > 0) step.consumes = init.consumes;
	if (init.produces && init.produces.length > 0) step.produces = init.produces;
	if (init.handler) step.handler = init.handler;
	if (init.configuration && Object.keys(init.configuration).length > 0) {
		step.configuration = init.configuration;
	}
	return step;
}

function makeAction(init: {
	id: string;
	owner: ActionResourceRef;
	type: string;
	runtime: string;
	label: string;
	available: boolean;
	unavailableReason?: string;
	inputs?: ActionInputDefinition[];
	root: ActionStepDefinition;
}): ActionDefinition {
	return {
		id: init.id,
		owner: init.owner,
		type: init.type,
		runtime: init.runtime,
		label: init.label,
		inputs: init.inputs ?? [],
		availability: init.unavailableReason
			? { available: init.available, reason: init.unavailableReason }
			: { available: init.available },
		root: init.root,
	};
}

/**
 * A literal `${key}` placeholder, written by concatenation because the text
 * *is* the placeholder. The command handler resolves these against the run's
 * value store at execution time; nothing interpolates them here.
 */
const VALUE_TEMPLATE_OPEN = "${";
const valueTemplate = (key: string): string => `${VALUE_TEMPLATE_OPEN}${key}}`;

function port(init: ActionValuePort): ActionValuePort {
	const out = { ...init } as ActionValuePort & { required?: boolean };
	if (!out.required) delete out.required;
	return out;
}

/** Any provider string is accepted; an unknown or absent one means docker. */
function asProvider(value: string | undefined): ContainerProvider | undefined {
	return value === "podman" || value === "docker" ? value : undefined;
}

// --- git ------------------------------------------------------------------

interface GitCommandSpec {
	id: string;
	label: string;
	args: string[];
}

interface GitActionSpec {
	type: string;
	label: string;
	commands: GitCommandSpec[];
	inputs?: ActionInputDefinition[];
}

function gitActionSpecs(): GitActionSpec[] {
	const branchInput: ActionInputDefinition = {
		...port({
			key: "branch",
			type: "string",
			scope: SCOPE_ACTION,
			visibility: VISIBILITY_PUBLIC,
			required: true,
		}),
		label: "Branch",
	};
	const pathInput: ActionInputDefinition = {
		...port({
			key: "path",
			type: "path",
			scope: SCOPE_ACTION,
			visibility: VISIBILITY_INTERNAL,
			required: true,
		}),
		label: "Path",
	};
	return [
		{
			type: "pull",
			label: "Pull",
			commands: [
				{
					id: "get-ref",
					label: "Get ref",
					args: ["rev-parse", "--abbrev-ref", "HEAD"],
				},
				{
					id: "fetch",
					label: "Fetch",
					args: [
						"fetch",
						"--force",
						"origin",
						"+refs/heads/*:refs/remotes/origin/*",
					],
				},
				{
					id: "pull",
					label: "Pull",
					args: ["reset", "--hard", `origin/${valueTemplate("git.branch")}`],
				},
			],
		},
		{
			type: "fetch",
			label: "Fetch",
			commands: [
				{
					id: "fetch",
					label: "Fetch",
					args: [
						"fetch",
						"--force",
						"origin",
						"+refs/heads/*:refs/remotes/origin/*",
					],
				},
			],
		},
		{
			type: "push",
			label: "Push",
			commands: [
				{ id: "push", label: "Push", args: ["push", "origin", "HEAD"] },
			],
		},
		{
			type: "branches",
			label: "List branches",
			commands: [
				{
					id: "branches",
					label: "List branches",
					args: ["branch", "--all", "--format=%(refname:short)"],
				},
			],
		},
		{
			type: "checkout",
			label: "Checkout branch",
			inputs: [branchInput],
			commands: [
				{
					id: "checkout",
					label: "Checkout branch",
					args: ["switch", valueTemplate("branch")],
				},
			],
		},
		{
			type: "worktree-list",
			label: "List worktrees",
			commands: [
				{
					id: "worktree-list",
					label: "List worktrees",
					args: ["worktree", "list", "--porcelain"],
				},
			],
		},
		{
			type: "worktree-add",
			label: "Add worktree",
			inputs: [branchInput, pathInput],
			commands: [
				{
					id: "worktree-add",
					label: "Add worktree",
					args: [
						"worktree",
						"add",
						valueTemplate("path"),
						valueTemplate("branch"),
					],
				},
			],
		},
		{
			type: "worktree-remove",
			label: "Remove worktree",
			inputs: [pathInput],
			commands: [
				{
					id: "worktree-remove",
					label: "Remove worktree",
					args: ["worktree", "remove", valueTemplate("path")],
				},
			],
		},
	];
}

export function compileGitActions(
	appIdent: string,
	workingDirectory: string,
): ActionDefinition[] {
	return gitActionSpecs().map((spec) => {
		const id = resourceActionId("app", appIdent, spec.type, "git");
		const steps = spec.commands.map((command) => {
			const configuration: Record<string, unknown> = {
				command: "git",
				args: [...command.args],
				dir: workingDirectory,
			};
			const produces: ActionValuePort[] = [];
			const consumes: ActionValuePort[] = [];
			if (command.id === "get-ref") {
				configuration.captureStdout = "git.branch";
				configuration.captureType = "string";
				produces.push(
					port({
						key: "git.branch",
						type: "string",
						scope: SCOPE_ACTION,
						visibility: VISIBILITY_INTERNAL,
					}),
				);
			}
			if (command.id === "pull") {
				consumes.push(
					port({
						key: "git.branch",
						type: "string",
						scope: SCOPE_ACTION,
						visibility: VISIBILITY_INTERNAL,
						required: true,
					}),
				);
			}
			return makeStep({
				id: stepId(id, command.id),
				kind: KIND.command,
				label: command.label,
				produces,
				consumes,
				handler: "git",
				configuration,
			});
		});
		return makeAction({
			id,
			owner: { kind: "app", id: appIdent },
			type: spec.type,
			runtime: "git",
			label: spec.label,
			available: workingDirectory !== "",
			...(workingDirectory === ""
				? { unavailableReason: "checkout required" }
				: {}),
			inputs: spec.inputs,
			root: makeStep({
				id: stepId(id, "root"),
				kind: KIND.composite,
				label: spec.label,
				children: steps,
			}),
		});
	});
}

// --- compose lifecycle ----------------------------------------------------

export function compileDockerLifecycleActions(
	appIdent: string,
	target: ActionTarget,
): ActionDefinition[] {
	if (target.runtime !== "docker" || target.action !== "run") return [];
	const out: ActionDefinition[] = [];
	for (const provider of ["docker", "podman"] as const) {
		out.push(
			...compileLifecycleForRuntime(
				appIdent,
				target,
				provider,
				target.profile ?? "default",
			),
		);
	}
	return out;
}

function compileLifecycleForRuntime(
	appIdent: string,
	target: ActionTarget,
	provider: ContainerProvider,
	profile: string,
): ActionDefinition[] {
	const composeCommand = composeCommandForRuntime(provider);
	const dir = path.dirname(target.sourcePath);
	const sequences: Array<{ action: string; label: string; args: string[][] }> =
		[
			{ action: "stop", label: "Stop", args: [["down"]] },
			{ action: "restart", label: "Restart", args: [["down"], ["up", "-d"]] },
		];
	return sequences.map((sequence) => {
		const id = resourceActionId(
			"app",
			appIdent,
			sequence.action,
			provider,
			profile,
		);
		const steps = sequence.args.map((args, index) =>
			makeStep({
				id: stepId(id, sequence.action, String(index)),
				kind: KIND.command,
				label: sequence.label,
				handler: provider,
				configuration: {
					command: composeCommand,
					args: composeLifecycleArgs(target, args),
					dir,
				},
			}),
		);
		return makeAction({
			id,
			owner: { kind: "app", id: appIdent },
			type: sequence.action,
			runtime: provider,
			label: `${sequence.label} (${provider})`,
			available: true,
			root: makeStep({
				id: stepId(id, "root"),
				kind: KIND.composite,
				label: sequence.label,
				children: steps,
			}),
		});
	});
}

function composeLifecycleArgs(target: ActionTarget, args: string[]): string[] {
	const out = ["-f", target.sourcePath];
	if (target.profile) out.push("--profile", target.profile);
	return [...out, ...args];
}

// --- kubernetes lifecycle -------------------------------------------------

function helmUninstallArgs(
	meta: KubernetesTargetMetadata,
	identity: KubernetesExecutionIdentity,
	namespace: string,
	ignoreNotFound: boolean,
): string[] {
	const args = [
		"--kube-context",
		identity.context,
		"uninstall",
		meta.release,
		"--namespace",
		namespace,
	];
	if (ignoreNotFound) args.push("--ignore-not-found");
	return args;
}

function helmInstallArgs(
	meta: KubernetesTargetMetadata,
	identity: KubernetesExecutionIdentity,
	namespace: string,
): string[] {
	const args = [
		"--kube-context",
		identity.context,
		"upgrade",
		"--install",
		meta.release,
		meta.chartPath,
		"--namespace",
		namespace,
	];
	for (const value of meta.valuesFiles ?? []) args.push("--values", value);
	const image = meta.image;
	const valuePaths = image?.valuePaths;
	if (valuePaths?.repository && image?.repository) {
		args.push("--set", `${valuePaths.repository}=${image.repository}`);
	}
	if (valuePaths?.tag && image?.tag) {
		args.push("--set", `${valuePaths.tag}=${image.tag}`);
	}
	if (valuePaths?.pullPolicy && image?.pullPolicy) {
		args.push("--set", `${valuePaths.pullPolicy}=${image.pullPolicy}`);
	}
	return args;
}

export function compileKubernetesLifecycleActions(
	appIdent: string,
	target: ActionTarget,
): ActionDefinition[] {
	if (target.runtime !== "kubernetes" || target.action !== "run") return [];
	const meta = target.kubernetes;
	if (!meta) return [];
	const profile = target.profile ? target.profile : "local";
	const namespace = meta.namespace ? meta.namespace : "default";
	const identity = resolveKubernetesIdentity(
		target.provider,
		meta.clusterName,
		meta.contextName,
	);

	const stopId = resourceActionId(
		"app",
		appIdent,
		"stop",
		"kubernetes",
		profile,
	);
	const stop = makeAction({
		id: stopId,
		owner: { kind: "app", id: appIdent },
		type: "stop",
		runtime: "kubernetes",
		label: "Stop",
		available: true,
		root: makeStep({
			id: stepId(stopId, "root"),
			kind: KIND.composite,
			label: "Stop",
			children: [
				makeStep({
					id: stepId(stopId, "stop", "0"),
					kind: KIND.command,
					label: "Uninstall Helm release",
					handler: "kubernetes",
					configuration: {
						command: "helm",
						args: helmUninstallArgs(meta, identity, namespace, true),
					},
				}),
			],
		}),
	});

	const restartId = resourceActionId(
		"app",
		appIdent,
		"restart",
		"kubernetes",
		profile,
	);
	const restart = makeAction({
		id: restartId,
		owner: { kind: "app", id: appIdent },
		type: "restart",
		runtime: "kubernetes",
		label: "Restart",
		available: true,
		root: makeStep({
			id: stepId(restartId, "root"),
			kind: KIND.composite,
			label: "Restart",
			children: [
				makeStep({
					id: stepId(restartId, "restart", "0"),
					kind: KIND.command,
					label: "Uninstall Helm release",
					handler: "kubernetes",
					configuration: {
						command: "helm",
						args: helmUninstallArgs(meta, identity, namespace, true),
					},
				}),
				makeStep({
					id: stepId(restartId, "restart", "1"),
					kind: KIND.command,
					label: "Install Helm release",
					handler: "kubernetes",
					configuration: {
						command: "helm",
						args: helmInstallArgs(meta, identity, namespace),
					},
				}),
				makeStep({
					id: stepId(restartId, "restart", "2"),
					kind: KIND.readiness,
					label: "Wait for workloads",
					handler: "kubernetes",
					configuration: {
						probe: "kubernetes",
						resource: meta.release,
						context: identity.context,
						namespace,
						timeout: meta.wait?.timeout ?? "",
					},
				}),
			],
		}),
	});

	return [stop, restart];
}

// --- kubernetes cluster ---------------------------------------------------

export function compileKubernetesClusterActions(
	tools: ToolSet,
	/** The user's home, or undefined when it cannot be resolved. */
	homeDir: string | undefined,
): ActionDefinition[] {
	if (!tools.kind || !tools.kubectl || !tools.helm) return [];
	const providers: Array<{ name: ContainerProvider; label: string }> = [];
	if (tools.docker) providers.push({ name: "docker", label: "" });
	if (tools.podman) providers.push({ name: "podman", label: " (podman)" });
	const exportCommand = ["kind", "export", "kubeconfig", "--name", "devenv"];
	if (homeDir !== undefined && homeDir !== "") {
		exportCommand.push("--kubeconfig", `${homeDir}/.kube/config`);
	}
	const specs: Array<{ action: string; label: string; commands: string[][] }> =
		[
			{
				action: "status",
				label: "Check cluster",
				commands: [["kind", "get", "kubeconfig", "--name", "devenv"]],
			},
			{
				action: "create",
				label: "Create cluster",
				commands: [
					["kind", "create", "cluster", "--name", "devenv"],
					exportCommand,
				],
			},
			{
				action: "delete",
				label: "Delete cluster",
				commands: [["kind", "delete", "cluster", "--name", "devenv"]],
			},
			{
				action: "recreate",
				label: "Recreate cluster",
				commands: [
					["kind", "delete", "cluster", "--name", "devenv"],
					["kind", "create", "cluster", "--name", "devenv"],
					exportCommand,
				],
			},
			{
				action: "export-kubeconfig",
				label: "Export kubeconfig",
				commands: [exportCommand],
			},
		];
	const out: ActionDefinition[] = [];
	for (const provider of providers) {
		for (const spec of specs) {
			const id = resourceActionId(
				"kubernetes",
				"local",
				spec.action,
				provider.name,
			);
			const steps = spec.commands.map((command, index) =>
				makeStep({
					id: stepId(id, spec.action, String(index)),
					kind: KIND.command,
					label: kubernetesCommandLabel(command),
					handler: "kubernetes",
					configuration: {
						command: command[0] ?? "",
						args: command.slice(1),
						...(provider.name === "podman"
							? { env: ["KIND_EXPERIMENTAL_PROVIDER=podman"] }
							: {}),
					},
				}),
			);
			const label = spec.label + provider.label;
			out.push(
				makeAction({
					id,
					owner: { kind: "kubernetes", id: "local" },
					type: spec.action,
					runtime: provider.name,
					label,
					available: true,
					root: makeStep({
						id: stepId(id, "root"),
						kind: KIND.composite,
						label,
						children: steps,
					}),
				}),
			);
		}
	}
	return out;
}

function kubernetesCommandLabel(command: string[]): string {
	switch (command[1]) {
		case "get":
			return "Check cluster";
		case "create":
			return "Create cluster";
		case "delete":
			return "Delete cluster";
		case "export":
			return "Export kubeconfig";
		default:
			return "Run Kubernetes command";
	}
}

// --- infrastructure -------------------------------------------------------

function infrastructureConfiguration(
	service: InfraService,
): Record<string, unknown> {
	// The Go map carries every key, empty string included; a map value has no
	// `omitempty`, so an absent key would be a wire difference.
	const configuration: Record<string, unknown> = {
		ident: service.ident,
		type: service.type ?? "",
		shellPath: service.shellPath ?? "",
		powerShellPath: service.powerShellPath ?? "",
		defaultRunner: service.defaultRunner ?? "",
		cwd: service.cwd ?? "",
		args: stringSlice(service.args),
		// The Go map always carries this key, `null` included.
		kubernetes: service.kubernetes ?? null,
	};
	return configuration;
}

/**
 * Go's `append([]string(nil), value...)`: an absent or empty list stays `null`
 * in JSON rather than becoming an empty array. Inside a configuration map
 * there is no `omitempty`, so the difference would reach the client.
 */
function stringSlice(value?: readonly string[]): string[] | null {
	return value && value.length > 0 ? [...value] : null;
}

function environmentSlice(values: Record<string, string>): string[] {
	return Object.keys(values)
		.sort()
		.map((key) => `${key}=${values[key]}`);
}

function infrastructureStartKind(serviceType: string): ActionStepKind {
	return serviceType === INFRA_SERVICE_TYPE.script
		? KIND.process
		: KIND.operation;
}

export function compileInfrastructure(
	service: InfraService,
): ActionDefinition[] {
	const runtime = service.type ? service.type : INFRA_SERVICE_TYPE.docker;
	let startRuntimes: string[] = [runtime];
	if (runtime === INFRA_SERVICE_TYPE.script) {
		if (service.defaultRunner) startRuntimes = [service.defaultRunner];
		else if (service.shellPath && service.powerShellPath) {
			startRuntimes = [SCRIPT_RUNNER.shell, SCRIPT_RUNNER.powershell];
		} else if (service.powerShellPath)
			startRuntimes = [SCRIPT_RUNNER.powershell];
		else startRuntimes = [SCRIPT_RUNNER.shell];
	}
	return [
		...startRuntimes.map((startRuntime) =>
			compileInfrastructureStart(service, runtime, startRuntime),
		),
		compileInfrastructureStop(service, runtime),
	];
}

function compileInfrastructureStart(
	service: InfraService,
	serviceType: string,
	startRuntime: string,
): ActionDefinition {
	const id = resourceActionId("infra", service.ident, "start", startRuntime);
	const configuration = infrastructureConfiguration(service);
	configuration.runner = startRuntime;
	if (serviceType === INFRA_SERVICE_TYPE.script) {
		if (startRuntime === SCRIPT_RUNNER.powershell) {
			configuration.command = "pwsh";
			configuration.args = [
				"-File",
				service.powerShellPath ?? "",
				...(service.args ?? []),
			];
		} else {
			configuration.command = "/bin/sh";
			configuration.args = [service.shellPath ?? "", ...(service.args ?? [])];
		}
		configuration.dir = service.cwd;
		configuration.logPath = service.logPath;
		configuration.handleKey = service.ident;
		if (service.env && Object.keys(service.env).length > 0) {
			configuration.env = environmentSlice(service.env);
		}
	}
	let children: ActionStepDefinition[] = [
		makeStep({
			id: stepId(id, "start"),
			kind: infrastructureStartKind(serviceType),
			label: `Start ${service.displayName}`,
			handler: serviceType,
			configuration,
		}),
	];
	if (serviceType === INFRA_SERVICE_TYPE.kubernetes && service.kubernetes) {
		const kube = service.kubernetes;
		const identity = resolveKubernetesIdentity(
			asProvider(kube.provider),
			kube.cluster,
			kube.context,
		);
		const env = kubernetesIdentityEnv(identity);
		const ensure: Record<string, unknown> = {
			command: "sh",
			args: [
				"-c",
				`kind export kubeconfig --name ${identity.cluster} 2>/dev/null || (kind create cluster --name ${identity.cluster} && kind export kubeconfig --name ${identity.cluster})`,
			],
		};
		if (env.length > 0) ensure.env = env;
		const helmArgs = [
			"--kube-context",
			identity.context,
			"upgrade",
			"--install",
			kube.release ?? "",
			kube.chartPath ?? "",
			"--namespace",
			kube.namespace ?? "",
		];
		for (const value of kube.values ?? []) helmArgs.push("--values", value);
		const namespace = kube.namespace ? kube.namespace : "default";
		const namespaceArgs = [
			"-c",
			`kubectl --context ${identity.context} create namespace ${namespace} --dry-run=client -o yaml | kubectl --context ${identity.context} apply -f -`,
		];
		children = [
			makeStep({
				id: stepId(id, "ensure-cluster"),
				kind: KIND.command,
				label: "Ensure cluster",
				handler: "kubernetes",
				configuration: ensure,
			}),
			makeStep({
				id: stepId(id, "create-namespace"),
				kind: KIND.command,
				label: "Create namespace",
				handler: "kubernetes",
				configuration: { command: "sh", args: namespaceArgs },
			}),
			makeStep({
				id: stepId(id, "helm-install"),
				kind: KIND.command,
				label: "Install Helm release",
				handler: "kubernetes",
				configuration: { command: "helm", args: helmArgs },
			}),
		];
	}
	if (
		serviceType === INFRA_SERVICE_TYPE.script ||
		serviceType === INFRA_SERVICE_TYPE.kubernetes ||
		serviceType === INFRA_SERVICE_TYPE.docker
	) {
		let readinessConfiguration: Record<string, unknown> =
			infrastructureConfiguration(service);
		if (serviceType === INFRA_SERVICE_TYPE.script) {
			readinessConfiguration = {
				probe: "process",
				processStepId: service.ident,
				stabilizationMs: 1000,
			};
		} else if (
			serviceType === INFRA_SERVICE_TYPE.kubernetes &&
			service.kubernetes
		) {
			const kube = service.kubernetes;
			const identity = resolveKubernetesIdentity(
				asProvider(kube.provider),
				kube.cluster,
				kube.context,
			);
			readinessConfiguration = {
				probe: "kubernetes",
				resource: kube.release,
				context: identity.context,
				namespace: kube.namespace,
				timeout: kube.timeout,
			};
		}
		children.push(
			makeStep({
				id: stepId(id, "readiness"),
				kind: KIND.readiness,
				label: "Wait for readiness",
				handler: serviceType,
				configuration: readinessConfiguration,
			}),
		);
	}
	let label = "Default";
	if (serviceType === INFRA_SERVICE_TYPE.script) {
		label = startRuntime === SCRIPT_RUNNER.powershell ? "PowerShell" : "Shell";
	}
	return makeAction({
		id,
		owner: { kind: "infrastructure", id: service.ident },
		type: "start",
		runtime: startRuntime,
		label,
		available: true,
		root: makeStep({
			id: stepId(id, "root"),
			kind: KIND.composite,
			label: `Start ${service.displayName}`,
			children,
		}),
	});
}

function compileInfrastructureStop(
	service: InfraService,
	runtime: string,
): ActionDefinition {
	const id = resourceActionId("infra", service.ident, "stop", runtime);
	let children: ActionStepDefinition[] = [
		makeStep({
			id: stepId(id, "stop"),
			kind: KIND.operation,
			label: `Terminate ${service.displayName}`,
			handler: runtime,
			configuration: infrastructureConfiguration(service),
		}),
		makeStep({
			id: stepId(id, "verify"),
			kind: KIND.operation,
			label: "Verify stopped",
			handler: runtime,
			configuration: infrastructureConfiguration(service),
		}),
	];
	if (runtime === INFRA_SERVICE_TYPE.kubernetes && service.kubernetes) {
		const kube = service.kubernetes;
		const identity = resolveKubernetesIdentity(
			asProvider(kube.provider),
			kube.cluster,
			kube.context,
		);
		children = [
			makeStep({
				id: stepId(id, "helm-uninstall"),
				kind: KIND.command,
				label: "Uninstall Helm release",
				handler: "kubernetes",
				configuration: {
					command: "helm",
					args: [
						"--kube-context",
						identity.context,
						"uninstall",
						kube.release ?? "",
						"--namespace",
						kube.namespace ?? "",
					],
				},
			}),
		];
	}
	return makeAction({
		id,
		owner: { kind: "infrastructure", id: service.ident },
		type: "stop",
		runtime,
		label: "Stop",
		available: true,
		root: makeStep({
			id: stepId(id, "root"),
			kind: KIND.composite,
			label: `Stop ${service.displayName}`,
			children,
		}),
	});
}

// --- generic operation ----------------------------------------------------

export function compileOperation(
	owner: ActionResourceRef,
	actionType: string,
	runtime: string,
	label: string,
	handler: string,
	...kinds: ActionStepKind[]
): ActionDefinition {
	const id = resourceActionId(owner.kind, owner.id, actionType, runtime);
	const children = kinds.map((kind, index) =>
		makeStep({
			id: stepId(id, handler, String(index)),
			kind,
			label,
			handler,
		}),
	);
	return makeAction({
		id,
		owner,
		type: actionType,
		runtime,
		label,
		available: true,
		root: makeStep({
			id: stepId(id, "root"),
			kind: KIND.composite,
			label,
			children,
		}),
	});
}

// --- kubernetes identity validation ---------------------------------------

/**
 * Rejects explicit cluster/context collisions across providers. The legacy
 * default `devenv` identity stays compatible while profiles migrate to
 * provider-scoped names.
 */
export function validateKubernetesIdentities(
	targets: readonly ActionTarget[],
): void {
	const seen = new Map<string, ContainerProvider>();
	for (const target of targets) {
		if (target.runtime !== "kubernetes" || !target.kubernetes) continue;
		const rawCluster = target.kubernetes.clusterName;
		const cluster = rawCluster ? rawCluster : "devenv";
		const context = target.kubernetes.contextName
			? target.kubernetes.contextName
			: `kind-${cluster}`;
		const provider: ContainerProvider = target.provider
			? target.provider
			: "docker";
		const key = `${cluster}\u0000${context}`;
		const previous = seen.get(key);
		if (
			previous !== undefined &&
			previous !== provider &&
			cluster !== "devenv"
		) {
			throw new Error(
				`Kubernetes cluster/context ${JSON.stringify(cluster)}/${JSON.stringify(context)} claimed by providers ${JSON.stringify(previous)} and ${JSON.stringify(provider)}`,
			);
		}
		seen.set(key, provider);
	}
}
