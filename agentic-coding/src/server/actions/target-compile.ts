// Target-driven definition compilers (`port-action-execution-to-bun`,
// task 1.3).
//
// Ported from `server/pkg/actionregistry/targets.go`.
//
// A discovered target (a compose file, a shell script, a Kubernetes release, a
// build tool invocation) becomes an immutable definition here: the leaf that
// runs it, the dependency steps that must be up first, the readiness gate, the
// failure-only diagnostics and cleanup steps, and the Docker build/artifact
// pipeline.
//
// Everything machine-specific is a parameter rather than an ambient read: the
// container runtime selection, the checkout directory, the configuration
// directory and the temp directory. Go reads the last two in
// `dockerBuildSteps` (`resources.ResolveConfigDir`, `os.TempDir`), which is why
// the fixture can pin them and compare byte for byte.
import fs from "node:fs";
import path from "node:path";
import type {
	ActionDefinition,
	ActionStepDefinition,
	ActionValuePort,
} from "@devenv/types";
import { resourceActionId, stableId, stepId } from "./identity.ts";
import {
	type ActionTarget,
	composeCommandForRuntime,
	DEFAULT_CONTAINER_RUNTIME,
	type DependencyRef,
	kubernetesIdentityEnv,
	type RuntimeCommands,
	resolveKubernetesIdentity,
	runtimeCommandForRuntime,
	type ToolSet,
} from "./targets.ts";

/** Resolves a dependency reference to its owning app and target. */
export type DependencyResolver = (
	ref: DependencyRef,
) => { appIdent: string; target: ActionTarget } | undefined;

interface TargetCompileOptions {
	/** Omitted means "all tools present", matching Go's nil `*ToolSet`. */
	tools?: ToolSet;
	checkoutDir?: string;
	/** Container runtime selection; defaults to Go's initial docker selection. */
	runtime?: RuntimeCommands;
	/** Configuration directory the build-context templates are copied from. */
	configDir?: string;
	/** Temp directory the build-context marker file lives in. */
	tempDir?: string;
	/** Source-presence probe for a target's availability. */
	sourceExists?: (path: string) => boolean;
}

const KIND = {
	composite: "composite",
	command: "command",
	process: "process",
	readiness: "readiness",
	operation: "operation",
	cleanup: "cleanup",
} as const;

const CONDITION_ON_FAILURE = "on-failure";
const FAILURE_ALWAYS_RUN = "always-run";
const SCOPE_ACTION = "action";
const VISIBILITY_PUBLIC = "public";
const VISIBILITY_INTERNAL = "internal";
const VISIBILITY_EPHEMERAL = "ephemeral";

const VALUE_TEMPLATE_OPEN = "${";
const valueTemplate = (key: string): string => `${VALUE_TEMPLATE_OPEN}${key}}`;

interface StepInit {
	id: string;
	kind: (typeof KIND)[keyof typeof KIND];
	label: string;
	children?: ActionStepDefinition[];
	condition?: "always" | "on-success" | "on-failure";
	failurePolicy?: "stop" | "continue" | "always-run";
	consumes?: ActionValuePort[];
	produces?: ActionValuePort[];
	handler?: string;
	configuration?: Record<string, unknown>;
}

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

function port(init: ActionValuePort & { required?: boolean }): ActionValuePort {
	const out = { ...init } as ActionValuePort & { required?: boolean };
	if (!out.required) delete out.required;
	return out;
}

export function actionLabel(action: string, label: string): string {
	const verb = action.slice(0, 1).toUpperCase() + action.slice(1);
	return label.trim() === "" ? verb : `${verb}: ${label}`;
}

/** Go's `append([]string(nil), value...)`: absent or empty stays JSON null. */
function stringListOrNull(
	value: readonly string[] | undefined,
): string[] | null {
	return value && value.length > 0 ? [...value] : null;
}

/**
 * Go copies a dependency list with `append([]DependencyRef(nil), value...)`,
 * which is `null` for an absent or empty list. Inside a configuration map there
 * is no `omitempty`, so the difference would reach the client.
 */
function objectListOrNull<T extends object>(
	value: readonly T[] | undefined,
): T[] | null {
	return value && value.length > 0
		? value.map((entry) => ({ ...entry }))
		: null;
}

function environmentSlice(values: Record<string, string>): string[] {
	return Object.keys(values)
		.sort()
		.map((key) => `${key}=${values[key]}`);
}

function intString(value: number): string {
	return String(value);
}

// --- target graph ---------------------------------------------------------

export function compileTarget(
	appIdent: string,
	target: ActionTarget,
): ActionDefinition {
	return compileTargetGraph(appIdent, target, undefined, "");
}

export function compileTargetGraph(
	appIdent: string,
	target: ActionTarget,
	resolver?: DependencyResolver,
	checkoutDir = "",
	runtime: RuntimeCommands = DEFAULT_CONTAINER_RUNTIME,
	paths: {
		configDir?: string;
		tempDir?: string;
		sourceExists?: (p: string) => boolean;
	} = {},
): ActionDefinition {
	// Go re-selects the runtime command for a docker target explicitly.
	const runtimeCommand =
		target.runtime === "docker"
			? runtimeCommandForRuntime("docker")
			: runtime.runtimeCommand;
	return compileTargetWithRuntime({
		appIdent,
		target,
		resolver,
		composeCommand: runtime.composeCommand,
		runtimeCommand,
		actionRuntime: target.runtime,
		checkoutDir,
		configDir: paths.configDir ?? "",
		tempDir: paths.tempDir ?? "",
		...(paths.sourceExists ? { sourceExists: paths.sourceExists } : {}),
	});
}

/**
 * Generates actions for all runtimes a target supports:
 * - Docker targets get an additional podman variant.
 * - Shell-based targets get Tmux (a tmux window) and Shell (command) variants.
 * Missing tools remove a variant instead of producing an action that cannot run.
 */
export function compileContainerTargets(
	appIdent: string,
	target: ActionTarget,
	resolver: DependencyResolver | undefined,
	options: TargetCompileOptions = {},
): ActionDefinition[] {
	const tools = options.tools;
	const checkoutDir = options.checkoutDir ?? "";
	const runtime = options.runtime ?? DEFAULT_CONTAINER_RUNTIME;

	if (target.runtime === "docker") {
		if (tools && !tools.docker && !tools.podman) return [];
		const dockerTarget: ActionTarget = { ...target, provider: "docker" };
		const results: ActionDefinition[] = [
			{
				...compileTargetGraph(
					appIdent,
					dockerTarget,
					resolver,
					checkoutDir,
					runtime,
					pathOptions(options),
				),
				runtime: "docker",
			},
		];
		if (!tools || (tools.podman && tools.podmanCompose)) {
			const podmanTarget: ActionTarget = { ...target, provider: "podman" };
			const podmanAction = compileTargetWithRuntime({
				...pathOptions(options),
				appIdent,
				target: podmanTarget,
				resolver,
				composeCommand: composeCommandForRuntime("podman"),
				runtimeCommand: runtimeCommandForRuntime("podman"),
				actionRuntime: "podman",
				checkoutDir,
			});
			if (podmanAction.id !== (results[0] as ActionDefinition).id) {
				results.push(podmanAction);
			}
		}
		if (tools && (!tools.docker || !tools.dockerCompose)) results.shift();
		return results;
	}

	if (
		target.runtime === "shell" ||
		target.runtime === "systemshell" ||
		target.runtime === "powershell"
	) {
		const results: ActionDefinition[] = [];
		if (!tools || tools.tmux) {
			results.push(
				compileTmuxAction(appIdent, target, resolver, checkoutDir, runtime),
			);
		}
		const scriptRuntime = `command-${target.runtime}`;
		const shellAction = compileTargetWithRuntime({
			...pathOptions(options),
			appIdent,
			target,
			resolver,
			composeCommand:
				target.runtime === "powershell" ? "" : runtime.composeCommand,
			runtimeCommand: runtime.runtimeCommand,
			actionRuntime: scriptRuntime,
			checkoutDir,
			leafKind: KIND.command,
		});
		shellAction.label = `Shell ${target.label}`;
		if (results.length === 0 || shellAction.id !== results[0]?.id) {
			results.push(shellAction);
		}
		return results;
	}

	if (target.runtime === "kubernetes" && target.action === "run") {
		if (tools && (!tools.kind || !tools.kubectl || !tools.helm)) return [];
		const providers = target.provider
			? [target.provider]
			: (["docker", "podman"] as const);
		const results: ActionDefinition[] = [];
		for (const provider of providers) {
			if (
				tools &&
				((provider === "docker" && !tools.docker) ||
					(provider === "podman" && !tools.podman))
			) {
				continue;
			}
			const variant: ActionTarget = { ...target, provider };
			const action = compileTargetWithRuntime({
				...pathOptions(options),
				appIdent,
				target: variant,
				resolver,
				composeCommand: composeCommandForRuntime(provider),
				runtimeCommand: runtimeCommandForRuntime(provider),
				actionRuntime: provider,
				checkoutDir,
			});
			if (results.length === 0 || action.id !== results[0]?.id) {
				results.push(action);
			}
		}
		return results;
	}

	return [
		compileTargetGraph(
			appIdent,
			target,
			resolver,
			checkoutDir,
			runtime,
			pathOptions(options),
		),
	];
}

/** The path/tool options every `compileTargetWithRuntime` call needs. */
function pathOptions(options: TargetCompileOptions): {
	configDir: string;
	tempDir: string;
	sourceExists?: (p: string) => boolean;
} {
	return {
		configDir: options.configDir ?? "",
		tempDir: options.tempDir ?? "",
		...(options.sourceExists ? { sourceExists: options.sourceExists } : {}),
	};
}

export function compileContainerTargetsWithTools(
	appIdent: string,
	target: ActionTarget,
	resolver: DependencyResolver | undefined,
	tools: ToolSet,
	options: Omit<TargetCompileOptions, "tools"> = {},
): ActionDefinition[] {
	return compileContainerTargets(appIdent, target, resolver, {
		...options,
		tools,
	});
}

interface CompileTargetWithRuntimeInit {
	appIdent: string;
	target: ActionTarget;
	resolver?: DependencyResolver;
	composeCommand: string;
	runtimeCommand: string;
	actionRuntime: string;
	checkoutDir: string;
	configDir: string;
	tempDir: string;
	leafKind?: ActionStepDefinition["kind"];
	sourceExists?: (path: string) => boolean;
}

function compileTargetWithRuntime(
	init: CompileTargetWithRuntimeInit,
): ActionDefinition {
	const {
		appIdent,
		target,
		resolver,
		composeCommand,
		runtimeCommand,
		actionRuntime,
		checkoutDir,
		configDir,
		tempDir,
	} = init;
	const profile = target.profile ? target.profile : "default";
	const id = resourceActionId(
		"app",
		appIdent,
		target.action,
		actionRuntime,
		profile,
	);
	const rootId = stepId(id, "root");
	let leafKind: ActionStepDefinition["kind"] = KIND.command;
	if (init.leafKind) {
		leafKind = init.leafKind;
	} else if (
		target.action === "run" &&
		target.runtime !== "docker" &&
		target.runtime !== "kubernetes"
	) {
		leafKind = KIND.process;
	}

	const env: Record<string, string> = { ...(target.env ?? {}) };
	for (const binding of target.bindings ?? []) {
		if (binding.destination === "env") {
			env[binding.name] = valueTemplate(`endpoint.${binding.export}`);
		}
	}

	const leaf = makeStep({
		id: stepId(id, "execute"),
		kind: leafKind,
		label: target.label,
		handler: actionRuntime,
		// Every key is present with Go's own empty value: a map has no
		// `omitempty`, so an absent key would be a wire difference.
		configuration: {
			targetId: target.id,
			command: target.command ?? "",
			args: stringListOrNull(target.args),
			profile: target.profile ?? "",
			launchMode: target.launchMode ?? "",
			requires: objectListOrNull(target.requires),
		},
	});
	if (Object.keys(env).length > 0) {
		leaf.configuration = { ...leaf.configuration, env: environmentSlice(env) };
	}
	if ((target.exports ?? []).length > 0) {
		const exports = (target.exports ?? []).map((endpoint) => ({
			name: endpoint.name,
			protocol: endpoint.protocol,
			host:
				endpoint.host === undefined || endpoint.host === ""
					? "127.0.0.1"
					: endpoint.host,
			port: endpoint.port,
		}));
		leaf.configuration = {
			...leaf.configuration,
			endpointExports: exports,
		};
		leaf.produces = (target.exports ?? []).map((endpoint) =>
			port({
				key: `endpoint.${endpoint.name}`,
				type: "endpoint",
				scope: SCOPE_ACTION,
				visibility: VISIBILITY_PUBLIC,
			}),
		);
	}
	// Shell-based build/test actions must run from the checkout directory.
	if (
		checkoutDir !== "" &&
		target.runtime !== "docker" &&
		target.runtime !== "kubernetes" &&
		(target.action === "build" || target.action === "test")
	) {
		leaf.configuration = { ...leaf.configuration, dir: checkoutDir };
	}
	if (target.runtime === "docker" && target.action === "run") {
		leaf.kind = KIND.command;
		const args = ["-f", target.sourcePath, "up", "-d"];
		if (
			target.profile &&
			!composeCommand.startsWith("podman-compose") &&
			!composeCommand.startsWith("docker-compose")
		) {
			args.push("--profile", target.profile);
		}
		const dir =
			checkoutDir !== "" ? checkoutDir : path.dirname(target.sourcePath);
		// The compose leaf replaces the whole configuration: the target's own
		// argv is not what runs.
		leaf.configuration = { command: composeCommand, args, dir };
		if (Object.keys(env).length > 0) {
			leaf.configuration.env = environmentSlice(env);
		}
	}

	let children: ActionStepDefinition[] = [];
	if (target.action === "run") {
		children.push(
			...compileDependencySteps(
				id,
				target.requires ?? [],
				resolver,
				new Map(),
				composeCommand,
				runtimeCommand,
				checkoutDir,
			),
		);
	}
	children.push(leaf);
	if (target.runtime === "docker" && target.action === "run") {
		children.push(
			makeStep({
				id: stepId(id, "readiness"),
				kind: KIND.readiness,
				label: "Wait for containers",
				handler: actionRuntime,
				configuration: {
					probe: "compose",
					command: composeCommand,
					args: ["-f", target.sourcePath],
					stabilizationMs: 3000,
				},
			}),
			makeStep({
				id: stepId(id, "diagnostics"),
				kind: KIND.operation,
				label: "Inspect failed containers",
				handler: actionRuntime,
				condition: CONDITION_ON_FAILURE,
				failurePolicy: FAILURE_ALWAYS_RUN,
			}),
		);
	}
	if (
		target.runtime === "docker" &&
		(target.action === "build" || target.action === "test")
	) {
		const buildSteps = dockerBuildSteps(id, appIdent, target, runtimeCommand, {
			checkoutDir,
			configDir,
			tempDir,
		});
		children = target.action === "test" ? buildSteps.slice(0, 1) : buildSteps;
	} else if (target.runtime === "kubernetes" && target.action === "run") {
		children = [
			...children.slice(0, -1),
			...kubernetesSteps(id, target, runtimeCommand),
		];
	}

	let label = target.label;
	if (actionRuntime === "podman" && label === "Docker") label = "Podman";
	const root = makeStep({
		id: rootId,
		kind: KIND.composite,
		label: actionLabel(target.action, label),
		children,
	});
	const availability = targetAvailability(target, init.sourceExists);

	return {
		id,
		owner: { kind: "app", id: appIdent },
		type: target.action,
		runtime: actionRuntime,
		label,
		inputs: [],
		availability,
		root,
	};
}

/**
 * Source availability. Go stats the target's source path inside the compiler;
 * the probe is injectable so a fixture can pin the answer and the compiler stays
 * a pure function of its inputs in tests.
 */
function targetAvailability(
	target: ActionTarget,
	sourceExists: (path: string) => boolean = fs.existsSync,
): { available: boolean; reason?: string } {
	if (target.sourcePath === "") return { available: true };
	if (sourceExists(target.sourcePath)) return { available: true };
	return {
		available: false,
		reason: `required source unavailable: ${target.sourcePath}`,
	};
}

// --- tmux -----------------------------------------------------------------

function compileTmuxAction(
	appIdent: string,
	target: ActionTarget,
	resolver: DependencyResolver | undefined,
	checkoutDir: string,
	runtime: RuntimeCommands = DEFAULT_CONTAINER_RUNTIME,
): ActionDefinition {
	const profile = target.profile ? target.profile : "default";
	const id = resourceActionId("app", appIdent, target.action, "tmux", profile);
	const rootId = stepId(id, "root");

	// A shell wrapper that runs the target command then waits for a keypress so
	// the tmux window stays open after the command finishes.
	let wrapper = target.command ?? "";
	for (const arg of target.args ?? []) wrapper += ` ${arg}`;
	wrapper += "; echo; printf 'Press Enter to close this window...'; read";

	const tmuxArgs = [
		"new-window",
		"-P",
		"-F",
		"#{window_id}",
		"-n",
		target.label,
	];
	let dir = checkoutDir;
	if (dir === "") dir = target.workingDir ?? "";
	if (dir === "") dir = path.dirname(target.sourcePath);
	if (dir !== "") tmuxArgs.push("-c", dir);
	tmuxArgs.push("sh", "-c", wrapper);

	const leaf = makeStep({
		id: stepId(id, "execute"),
		kind: KIND.command,
		label: target.label,
		handler: "tmux",
		configuration: { command: "tmux", args: tmuxArgs },
	});
	const children: ActionStepDefinition[] = [];
	if (target.action === "run") {
		children.push(
			...compileDependencySteps(
				id,
				target.requires ?? [],
				resolver,
				new Map(),
				runtime.composeCommand,
				runtime.runtimeCommand,
				checkoutDir,
			),
		);
	}
	children.push(leaf);
	return {
		id,
		owner: { kind: "app", id: appIdent },
		type: target.action,
		runtime: "tmux",
		label: `Tmux ${target.label}`,
		inputs: [],
		availability: { available: true },
		root: makeStep({
			id: rootId,
			kind: KIND.composite,
			label: actionLabel(target.action, `Tmux ${target.label}`),
			children,
		}),
	};
}

// --- dependency steps -----------------------------------------------------

function dependencyLifecycle(ref: DependencyRef): string {
	return ref.lifecycle && ref.lifecycle !== "" ? ref.lifecycle : "shared";
}

function dependencyIdentity(ref: DependencyRef): string {
	if (ref.infra) {
		if (ref.provider || ref.runtime || ref.profile) {
			return stableId(
				ref.infra,
				ref.runtime ?? "",
				ref.profile ?? "",
				ref.provider ?? "",
			);
		}
		return ref.infra;
	}
	return stableId(
		ref.app ?? "",
		ref.runtime ?? "",
		ref.profile ?? "",
		ref.provider ?? "",
	);
}

function compileDependencySteps(
	actionId: string,
	refs: readonly DependencyRef[],
	resolver: DependencyResolver | undefined,
	path_: ReadonlyMap<string, boolean>,
	composeCommand: string,
	runtimeCommand: string,
	checkoutDir: string,
): ActionStepDefinition[] {
	return refs.map((ref, index) => {
		const identity = dependencyIdentity(ref);
		const semanticId = stepId(actionId, "dependency", String(index), identity);
		const step = makeStep({
			id: semanticId,
			kind: KIND.composite,
			label: `Start dependency: ${identity}`,
			configuration: {
				lifecycle: dependencyLifecycle(ref),
				dependencyTarget: identity,
			},
		});
		const children: ActionStepDefinition[] = [];
		if (!path_.has(identity) && resolver && ref.lifecycle !== "external") {
			const resolved = resolver(ref);
			if (resolved) {
				const next = new Map(path_);
				next.set(identity, true);
				children.push(
					...compileDependencySteps(
						semanticId,
						resolved.target.requires ?? [],
						resolver,
						next,
						composeCommand,
						runtimeCommand,
						checkoutDir,
					),
					...dependencyExecutionSteps(
						semanticId,
						resolved.appIdent,
						resolved.target,
						composeCommand,
						runtimeCommand,
						checkoutDir,
						ref.provider,
					),
				);
			}
		}
		if (children.length === 0 && ref.lifecycle !== "external") {
			children.push(
				makeStep({
					id: stableId(semanticId, "start"),
					kind: KIND.operation,
					label: "Start dependency",
					handler: "infrastructure",
					configuration: { dependency: { ...ref } },
				}),
			);
		}
		children.push(
			makeStep({
				id: stableId(semanticId, "readiness"),
				kind: KIND.readiness,
				label: "Wait for readiness",
				handler: "dependency",
				configuration: {
					dependency: { ...ref },
					lifecycle: dependencyLifecycle(ref),
				},
			}),
		);
		step.children = children;
		// The semantic node also carries the execution key two paths to the same
		// dependency share.
		(step as ActionStepDefinition & { executionKey?: string }).executionKey =
			`dependency/${identity}`;
		return step;
	});
}

function dependencyExecutionSteps(
	parentStepId: string,
	appIdent: string,
	target: ActionTarget,
	composeCommand: string,
	runtimeCommand: string,
	checkoutDir: string,
	provider: DependencyRef["provider"],
): ActionStepDefinition[] {
	const id = parentStepId;
	const label = `Start application: ${appIdent}`;
	const dir = target.workingDir
		? target.workingDir
		: checkoutDir !== ""
			? checkoutDir
			: path.dirname(target.sourcePath);
	if (target.runtime === "docker") {
		let selectedCompose = composeCommand;
		let selectedRuntime = runtimeCommand;
		if (provider === "podman") {
			selectedCompose = composeCommandForRuntime("podman");
			selectedRuntime = runtimeCommandForRuntime("podman");
		} else if (provider === "docker") {
			selectedCompose = composeCommandForRuntime("docker");
			selectedRuntime = runtimeCommandForRuntime("docker");
		}
		const args = ["-f", target.sourcePath];
		if (
			target.profile &&
			!selectedCompose.startsWith("podman-compose") &&
			!selectedCompose.startsWith("docker-compose")
		) {
			args.push("--profile", target.profile);
		}
		args.push("up", "-d");
		return [
			makeStep({
				id: stableId(id, "start"),
				kind: KIND.command,
				label,
				handler: selectedRuntime,
				configuration: { command: selectedCompose, args, dir },
			}),
		];
	}
	if (
		target.runtime === "shell" ||
		target.runtime === "powershell" ||
		target.runtime === "systemshell"
	) {
		const shellDir = target.workingDir
			? target.workingDir
			: path.dirname(target.sourcePath);
		const configuration: Record<string, unknown> = {
			command: target.command ?? "",
			args: stringListOrNull(target.args),
			dir: shellDir,
			handleKey: appIdent,
		};
		if (target.env && Object.keys(target.env).length > 0) {
			configuration.env = environmentSlice(target.env);
		}
		return [
			makeStep({
				id: stableId(id, "start"),
				kind: KIND.process,
				label,
				handler: target.runtime,
				configuration,
			}),
		];
	}
	if (target.runtime === "kubernetes") {
		return kubernetesSteps(id, target, runtimeCommand);
	}
	return [
		makeStep({
			id: stableId(id, "start"),
			kind: KIND.operation,
			label,
			handler: target.runtime,
		}),
	];
}

// --- kubernetes workload --------------------------------------------------

/** Dependency resolution already produced this id; the caller owns the identity. */
function kubernetesSteps(
	id: string,
	target: ActionTarget,
	runtimeCommand: string,
): ActionStepDefinition[] {
	const meta = target.kubernetes;
	if (!meta) return [];
	const releaseKey = `helm.release.${id}`;
	const release = port({
		key: releaseKey,
		type: "helm-release",
		scope: SCOPE_ACTION,
		visibility: VISIBILITY_PUBLIC,
	});
	const identity = resolveKubernetesIdentity(
		target.provider,
		meta.clusterName,
		meta.contextName,
	);
	if (meta.provider) identity.provider = meta.provider;
	if (runtimeCommand === "podman") identity.provider = "podman";
	const kindEnv = kubernetesIdentityEnv(identity);

	const step = (
		name: string,
		label: string,
		command: string,
		args: string[],
	): ActionStepDefinition => {
		const configuration: Record<string, unknown> = { command, args };
		if (kindEnv.length > 0 && command === "kind") configuration.env = kindEnv;
		return makeStep({
			id: stepId(id, name),
			kind: KIND.command,
			label,
			handler: "kubernetes",
			configuration,
		});
	};

	const clusterName = identity.cluster;
	// One shell command instead of separate check/create steps: the
	// failure-condition reset logic interacts badly with the other
	// failure-only steps (diagnostics, cleanup) that run after a failure.
	const ensureArgs = [
		"-c",
		`kind export kubeconfig --name ${clusterName} 2>/dev/null || (kind create cluster --name ${clusterName} && kind export kubeconfig --name ${clusterName})`,
	];
	const ensureConfig: Record<string, unknown> = {
		command: "sh",
		args: ensureArgs,
	};
	if (kindEnv.length > 0) ensureConfig.env = kindEnv;
	const steps: ActionStepDefinition[] = [
		makeStep({
			id: stepId(id, "ensure-cluster"),
			kind: KIND.command,
			label: "Ensure cluster",
			handler: "kubernetes",
			configuration: ensureConfig,
		}),
	];

	const image = meta.image;
	if (image) {
		let imageRef = `${image.repository ?? ""}:${image.tag ?? ""}`;
		if (imageRef === ":") imageRef = "";
		if (imageRef !== "") {
			// `kind load docker-image` has issues with the podman Docker API
			// compatibility layer, so the image is saved and loaded as an archive.
			const tarPath = path.join(
				"/tmp",
				`devenv-image-${id.replaceAll("/", "-").replaceAll(":", "-").replaceAll(" ", "-")}.tar`,
			);
			const check = step("check-image", "Check image availability", "sh", [
				"-c",
				`${runtimeCommand} image exists ${imageRef}`,
			]);
			steps.push(check);
			const load = step("load-image", "Load image", "sh", [
				"-c",
				`${runtimeCommand} save ${imageRef} -o ${tarPath} && kind load image-archive ${tarPath} --name ${clusterName}`,
			]);
			if (kindEnv.length > 0)
				load.configuration = { ...load.configuration, env: kindEnv };
			steps.push(load);
		}
	}

	const namespace = meta.namespace ? meta.namespace : "default";
	(meta.secrets ?? []).forEach((secret, index) => {
		steps.push(
			step(`secret-${index}-delete`, "Delete secret", "kubectl", [
				"--context",
				identity.context,
				"delete",
				"secret",
				secret.name,
				"--namespace",
				namespace,
				"--ignore-not-found",
			]),
		);
		const create = step(`secret-${index}-create`, "Create secret", "kubectl", [
			"--context",
			identity.context,
			"create",
			"secret",
			"generic",
			secret.name,
			"--namespace",
			namespace,
		]);
		create.configuration = {
			...create.configuration,
			displayArgs: ["create", "secret", "generic", secret.name, "[REDACTED]"],
		};
		create.produces = [
			port({
				key: `secret.${secret.name}`,
				type: "secret-handle",
				scope: SCOPE_ACTION,
				visibility: "secret",
			}),
		];
		steps.push(create);
	});

	const namespaceStep = step("create-namespace", "Create namespace", "sh", [
		"-c",
		`kubectl --context ${identity.context} create namespace ${namespace} --dry-run=client -o yaml | kubectl --context ${identity.context} apply -f -`,
	]);
	namespaceStep.configuration = {
		...namespaceStep.configuration,
		displayArgs: [`Ensure namespace ${namespace} exists`],
	};
	steps.push(namespaceStep);

	const helmArgs = [
		"--kube-context",
		identity.context,
		"upgrade",
		"--install",
		meta.release,
		meta.chartPath,
		"--namespace",
		namespace,
	];
	for (const value of meta.valuesFiles ?? []) helmArgs.push("--values", value);
	for (const binding of target.bindings ?? []) {
		if (binding.destination === "helm" && binding.valuePath) {
			helmArgs.push(
				"--set",
				`${binding.valuePath}=${valueTemplate(`endpoint.${binding.export}`)}`,
			);
		}
	}
	const valuePaths = image?.valuePaths;
	if (valuePaths?.repository && image?.repository) {
		helmArgs.push("--set", `${valuePaths.repository}=${image.repository}`);
	}
	if (valuePaths?.tag && image?.tag) {
		helmArgs.push("--set", `${valuePaths.tag}=${image.tag}`);
	}
	if (valuePaths?.pullPolicy && image?.pullPolicy) {
		helmArgs.push("--set", `${valuePaths.pullPolicy}=${image.pullPolicy}`);
	}
	const helm = step("helm-install", "Install Helm release", "helm", helmArgs);
	helm.produces = [release];
	helm.configuration = {
		...helm.configuration,
		setValues: { [releaseKey]: meta.release },
	};
	steps.push(helm);

	const readinessConfig: Record<string, unknown> = {
		probe: "kubernetes",
		resource: meta.release,
		context: identity.context,
		namespace,
		timeout: meta.wait?.timeout ?? "",
	};
	const endpointExports = (meta.exports ?? []).map((endpoint) => {
		let host = endpoint.host ?? "";
		if (host === "" && endpoint.strategy === "kubernetes-service") {
			host = `${endpoint.resource ?? ""}.${namespace}.svc.cluster.local`;
		}
		if (host === "" && endpoint.strategy === "port-forward") host = "127.0.0.1";
		return {
			name: endpoint.name,
			protocol: endpoint.protocol,
			host,
			port: endpoint.port,
		};
	});
	const readinessOutputs = (meta.exports ?? []).map((endpoint) =>
		port({
			key: `endpoint.${endpoint.name}`,
			type: "endpoint",
			scope: SCOPE_ACTION,
			visibility: VISIBILITY_PUBLIC,
		}),
	);
	if (endpointExports.length > 0) {
		readinessConfig.endpointExports = endpointExports;
	}
	steps.push(
		makeStep({
			id: stepId(id, "readiness"),
			kind: KIND.readiness,
			label: "Wait for workloads",
			handler: "kubernetes",
			configuration: readinessConfig,
			produces: readinessOutputs,
		}),
		makeStep({
			id: stepId(id, "diagnostics"),
			kind: KIND.operation,
			label: "Collect workload diagnostics",
			handler: "kubernetes",
			condition: CONDITION_ON_FAILURE,
			failurePolicy: FAILURE_ALWAYS_RUN,
		}),
		makeStep({
			id: stepId(id, "cleanup-failed-release"),
			kind: KIND.cleanup,
			label: "Clean up failed release",
			handler: "kubernetes",
			condition: CONDITION_ON_FAILURE,
			failurePolicy: FAILURE_ALWAYS_RUN,
			configuration: {
				command: "helm",
				args: [
					"--kube-context",
					identity.context,
					"uninstall",
					valueTemplate(releaseKey),
					"--namespace",
					namespace,
				],
			},
		}),
	);

	for (const [index, forward] of (meta.ports ?? []).entries()) {
		const portStepId = stepId(id, `port-forward-${index}`);
		steps.push(
			makeStep({
				id: portStepId,
				kind: KIND.process,
				label: "Start port forward",
				handler: "kubernetes",
				configuration: {
					command: "kubectl",
					args: [
						"--context",
						identity.context,
						"port-forward",
						"--namespace",
						namespace,
						forward.resource,
						`${intString(forward.localPort)}:${intString(forward.remotePort)}`,
					],
				},
			}),
			makeStep({
				id: stepId(id, `port-forward-readiness-${index}`),
				kind: KIND.readiness,
				label: "Wait for port forward",
				handler: "kubernetes",
				configuration: {
					processStepId: portStepId,
					stabilizationMs: 1000,
				},
			}),
		);
	}
	return steps;
}

// --- docker build pipeline ------------------------------------------------

function dockerBuildSteps(
	id: string,
	appIdent: string,
	target: ActionTarget,
	runtimeCommand: string,
	options: { checkoutDir: string; configDir: string; tempDir: string },
): ActionStepDefinition[] {
	const dir =
		options.checkoutDir !== ""
			? options.checkoutDir
			: path.dirname(target.sourcePath);
	const imageRef = port({
		key: "image.ref",
		type: "image-ref",
		scope: SCOPE_ACTION,
		visibility: VISIBILITY_PUBLIC,
	});
	const artifactPath = port({
		key: "artifact.path",
		type: "path",
		scope: SCOPE_ACTION,
		visibility: VISIBILITY_INTERNAL,
	});
	const containerId = port({
		key: "artifact.container.id",
		type: "container-id",
		scope: SCOPE_ACTION,
		visibility: VISIBILITY_EPHEMERAL,
	});
	const step = (
		name: string,
		label: string,
		kind: (typeof KIND)[keyof typeof KIND],
	): ActionStepDefinition =>
		makeStep({ id: stepId(id, name), kind, label, handler: "docker" });

	const templatesDir = path.join(options.configDir, "templates");
	const templateMarker = path.join(
		options.tempDir,
		`devenv-templates-${appIdent}-${id}`,
	);

	// Copy templates (for example .dockerignore) before the build so the build
	// context does not carry large directories such as node_modules.
	const prepare = step(
		"prepare-build-context",
		"Prepare build context",
		KIND.command,
	);
	prepare.configuration = {
		command: "sh",
		args: [
			"-c",
			`ls -1A ${templatesDir}/ > ${templateMarker} 2>/dev/null; cp -r ${templatesDir}/. . 2>/dev/null; true`,
		],
		dir,
	};
	const build = step("build-image", "Build image", KIND.command);
	const imageName = `devenv-${appIdent}:latest`;
	build.configuration = {
		command: runtimeCommand,
		args: ["build", "-f", target.sourcePath, "-t", imageName, "."],
		dir,
		setValues: { "image.ref": imageName },
	};
	build.produces = [imageRef];
	const cleanupTemplates = step(
		"cleanup-build-context",
		"Clean up build context",
		KIND.command,
	);
	cleanupTemplates.failurePolicy = FAILURE_ALWAYS_RUN;
	cleanupTemplates.configuration = {
		command: "sh",
		args: [
			"-c",
			`if [ -f ${templateMarker} ]; then xargs -I{} rm -rf "{}" < ${templateMarker} 2>/dev/null; rm -f ${templateMarker}; fi`,
		],
		dir,
	};
	// Prune superseded images and unused volumes after every successful build.
	// Docker also has a distinct BuildKit cache while podman's builder prune
	// aliases image prune. Never `--all`: current tagged images must survive.
	let pruneCommand = `${runtimeCommand} image prune -f && ${runtimeCommand} volume prune -f`;
	if (runtimeCommand === "docker") {
		pruneCommand = `docker builder prune -f && ${pruneCommand}`;
	}
	const prune = step("prune-old-images", "Prune old images", KIND.command);
	prune.configuration = { command: "sh", args: ["-c", pruneCommand], dir };
	const inspect = step("inspect-artifacts", "Inspect artifacts", KIND.command);
	inspect.configuration = {
		command: runtimeCommand,
		args: [
			"inspect",
			"--format",
			"{{json .Config.Labels}}",
			valueTemplate("image.ref"),
		],
		captureJSONLabel: "devenv.artifacts",
		captureKey: "artifact.path",
	};
	inspect.consumes = [
		port({
			key: imageRef.key,
			type: imageRef.type,
			scope: SCOPE_ACTION,
			visibility: imageRef.visibility,
			required: true,
		}),
	];
	inspect.produces = [artifactPath];
	const create = step(
		"create-extractor",
		"Create artifact extractor",
		KIND.command,
	);
	create.configuration = {
		command: runtimeCommand,
		args: ["create", valueTemplate("image.ref")],
		captureStdout: "artifact.container.id",
		captureType: "container-id",
	};
	create.consumes = inspect.consumes;
	create.produces = [containerId];
	const copyArtifacts = step("copy-artifacts", "Copy artifacts", KIND.command);
	copyArtifacts.configuration = {
		command: runtimeCommand,
		args: [
			"cp",
			`${valueTemplate("artifact.container.id")}:${valueTemplate("artifact.path")}`,
			".",
		],
		dir,
	};
	copyArtifacts.consumes = [
		port({
			key: containerId.key,
			type: containerId.type,
			scope: SCOPE_ACTION,
			visibility: containerId.visibility,
			required: true,
		}),
		port({
			key: artifactPath.key,
			type: artifactPath.type,
			scope: SCOPE_ACTION,
			visibility: artifactPath.visibility,
			required: true,
		}),
	];
	const cleanup = step(
		"remove-extractor",
		"Remove artifact extractor",
		KIND.cleanup,
	);
	cleanup.failurePolicy = FAILURE_ALWAYS_RUN;
	cleanup.configuration = {
		command: runtimeCommand,
		args: ["rm", valueTemplate("artifact.container.id")],
	};
	cleanup.consumes = [
		port({
			key: containerId.key,
			type: containerId.type,
			scope: SCOPE_ACTION,
			visibility: containerId.visibility,
			required: true,
		}),
	];
	return [
		prepare,
		build,
		cleanupTemplates,
		prune,
		inspect,
		create,
		copyArtifacts,
		cleanup,
	];
}
