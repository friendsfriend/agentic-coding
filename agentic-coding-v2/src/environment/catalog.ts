import fs from "node:fs";
import path from "node:path";
import { type Config, object, text } from "../config.ts";
import { contained } from "../git.ts";
import type { TaskInfo } from "../state.ts";
import { targetAvailability } from "./availability.ts";
import { compileCompose, readCompose } from "./compose-config.ts";
import { readContainer } from "./container-config.ts";
import { expandDependencies, validateDependencies } from "./dependencies.ts";
import { readEndpoints } from "./endpoint.ts";
import { readEndpointCaRefs } from "./endpoint-ca.ts";
import { readEndpointAuth } from "./http-options.ts";
import { readKubernetes } from "./kubernetes-config.ts";
import type { Plan, Project, Target } from "./model.ts";
import { readQueryConnection } from "./query-config.ts";
import {
	type Action,
	defaultTargets,
	type Selection,
	selectTarget,
} from "./selection.ts";

const identifier = (value: unknown) => {
	const id = text(value, "environment identifier", 64);
	if (!/^[a-z][a-z0-9-]*$/.test(id))
		throw new Error("Invalid environment identifier");
	return id;
};
function variables(value: unknown): Record<string, string> {
	return Object.fromEntries(
		Object.entries(object(value ?? {})).map(([key, value]) => {
			if (
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
				["WORKSPACE", "CONFIG_DIR"].includes(key)
			)
				throw new Error("Invalid or reserved environment variable name");
			if (
				typeof value !== "string" ||
				value.includes("\0") ||
				value.length > 16000
			)
				throw new Error("Invalid environment variable mapping");
			return [key, value];
		}),
	);
}
function keysOnly(data: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(data).some((key) => !allowed.includes(key)))
		throw new Error(
			"Unsupported environment configuration field; check the v2 schema (legacy definitions are not loaded)",
		);
}
function readTarget(raw: unknown): Target {
	const data = object(raw);
	keysOnly(data, [
		"id",
		"action",
		"runtime",
		"command",
		"profile",
		"label",
		"cwd",
		"timeoutMs",
		"readyText",
		"environment",
		"secretRefs",
		"container",
		"compose",
		"kubernetes",
		"endpoints",
		"endpointCaRefs",
		"endpointAuthRefs",
		"queryConnection",
		"telemetry",
	]);
	if (
		data.runtime !== "shell" &&
		data.runtime !== "docker" &&
		data.runtime !== "podman" &&
		data.runtime !== "compose" &&
		data.runtime !== "kubernetes"
	)
		throw new Error("Unsupported environment runtime");
	if (data.runtime !== "kubernetes" && data.kubernetes !== undefined)
		throw new Error("Kubernetes configuration requires the Kubernetes runtime");
	if (
		data.runtime === "kubernetes" &&
		(data.action !== "run" ||
			data.container !== undefined ||
			data.compose !== undefined)
	)
		throw new Error("Kubernetes currently supports bare pod run targets only");
	if (data.runtime !== "compose" && data.compose !== undefined)
		throw new Error("Compose configuration requires the Compose runtime");
	if (
		data.runtime === "compose" &&
		(data.action !== "run" || data.container !== undefined)
	)
		throw new Error(
			"Compose currently supports run targets only, without container overrides",
		);
	if (
		data.runtime === "shell"
			? data.container !== undefined
			: data.command !== undefined || data.readyText !== undefined
	)
		throw new Error(
			"Shell commands/readiness and structured container configuration cannot be mixed",
		);
	if (
		(data.endpoints !== undefined ||
			data.endpointCaRefs !== undefined ||
			data.endpointAuthRefs !== undefined) &&
		(data.runtime !== "shell" || data.action !== "run")
	)
		throw new Error(
			"Named local endpoints currently require a shell run target",
		);
	if (
		data.queryConnection !== undefined &&
		(data.runtime !== "shell" || data.action !== "run" || !data.readyText)
	)
		throw new Error(
			"Query connections require a shell run target with an explicit readiness marker",
		);
	const container =
		data.runtime === "shell" ||
		data.runtime === "compose" ||
		data.runtime === "kubernetes"
			? undefined
			: readContainer(data.container);
	if (!["run", "build", "test"].includes(String(data.action)))
		throw new Error("Invalid environment target action");
	const timeoutMs = data.timeoutMs ?? (data.action === "run" ? 30000 : 600000);
	if (
		!Number.isSafeInteger(timeoutMs) ||
		Number(timeoutMs) < 100 ||
		Number(timeoutMs) > 3600000
	)
		throw new Error("Invalid environment timeoutMs");
	let telemetry: Target["telemetry"];
	if (data.telemetry !== undefined) {
		const capture = object(data.telemetry);
		keysOnly(capture, ["protocol", "listen"]);
		if (
			capture.protocol !== "otlp-http-json" ||
			capture.listen !== "127.0.0.1:0" ||
			data.runtime !== "shell" ||
			data.action !== "run" ||
			!data.readyText
		)
			throw new Error(
				"Native telemetry requires an explicit otlp-http-json loopback-ephemeral shell run target with readiness text",
			);
		telemetry = { protocol: "otlp-http-json", listen: "127.0.0.1:0" };
	}
	const environment = variables(data.environment),
		secretRefs = variables(data.secretRefs);
	if (
		telemetry &&
		[...Object.keys(environment), ...Object.keys(secretRefs)].some(
			(key) =>
				key.startsWith("AC_OTEL_") ||
				key.startsWith("OTEL_EXPORTER_OTLP_") ||
				key === "OTEL_RESOURCE_ATTRIBUTES" ||
				key === "OTEL_METRICS_EXPORTER",
		)
	)
		throw new Error(
			"Native telemetry exporter and attribution variables cannot be overridden",
		);
	if (Object.keys(environment).some((key) => key in secretRefs))
		throw new Error(
			"Environment variable has both a literal and secret reference",
		);
	for (const ref of Object.values(secretRefs))
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref))
			throw new Error("Invalid environment secret reference");
	if (
		container?.buildArgs.some(
			(key) => !(key in environment) && !(key in secretRefs),
		)
	)
		throw new Error(
			"Container build arguments require declared variables or secret references",
		);
	const cwd = text(data.cwd ?? ".", "environment cwd", 4096);
	if (path.isAbsolute(cwd))
		throw new Error("Environment cwd must be relative to the task workspace");
	const queryConnection = readQueryConnection(data.queryConnection, secretRefs);
	const endpoints = readEndpoints(data.endpoints),
		endpointCaRefs = readEndpointCaRefs(data.endpointCaRefs, endpoints);
	return {
		id: identifier(data.id),
		...(telemetry ? { telemetry } : {}),
		...(data.endpoints === undefined ? {} : { endpoints }),
		...(data.endpointCaRefs === undefined ? {} : { endpointCaRefs }),
		...(data.endpointAuthRefs === undefined
			? {}
			: {
					endpointAuthRefs: readEndpointAuth(
						data.endpointAuthRefs,
						endpoints,
						secretRefs,
					),
				}),
		action: data.action as Action,
		runtime: data.runtime,
		...(container ? { container } : {}),
		...(data.runtime === "kubernetes"
			? { kubernetes: readKubernetes(data.kubernetes) }
			: {}),
		...(data.runtime === "compose"
			? { compose: readCompose(data.compose) }
			: {}),
		command:
			data.runtime === "shell"
				? text(data.command, "environment command", 16000)
				: "",
		...(data.profile === undefined
			? {}
			: { profile: identifier(data.profile) }),
		...(data.label === undefined
			? {}
			: { label: text(data.label, "environment target label", 200) }),
		cwd,
		timeoutMs: Number(timeoutMs),
		readyText:
			data.readyText === undefined
				? null
				: text(data.readyText, "readiness text", 512),
		environment,
		secretRefs,
		...(queryConnection ? { queryConnection } : {}),
	};
}
function availableTargets(project: Project): Target[] {
	return project.targets.map((target) => ({
		...target,
		availability: targetAvailability(target),
	}));
}
export function projectView(project: Project) {
	const targets = availableTargets(project);
	return {
		...project,
		targets,
		defaultTargets: defaultTargets(targets, project.defaults),
	};
}
function parseDefaults(
	value: unknown,
	targets: Target[],
): Partial<Record<Action, string>> {
	const data = object(value);
	keysOnly(data, ["run", "build", "test"]);
	const result: Partial<Record<Action, string>> = {};
	for (const action of ["run", "build", "test"] as const) {
		if (data[action] === undefined) continue;
		const id = identifier(data[action]);
		if (!targets.some((target) => target.id === id && target.action === action))
			throw new Error(`Unknown ${action} default ${id}`);
		result[action] = id;
	}
	return result;
}
export function loadProjects(config: Config): Project[] {
	const file = path.join(config.configDir, "environments.json");
	if (!fs.existsSync(file)) return [];
	let data: Record<string, unknown>;
	try {
		data = object(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		throw new Error(
			`Invalid environment configuration: ${file}; values are not logged`,
		);
	}
	return parseProjects(config, data, (value) =>
		fs.realpathSync(text(value, "environment repository", 4096)),
	);
}
/** Schema-only parsing never opens repositories, referenced files, sockets or engines. */
export function validateProjects(config: Config, value: unknown): Project[] {
	return parseProjects(config, object(value), (value) =>
		text(value, "environment repository", 4096),
	);
}
function parseProjects(
	config: Config,
	data: Record<string, unknown>,
	repositoryPath: (value: unknown) => string,
): Project[] {
	keysOnly(data, ["version", "projects"]);
	if (data.version !== 1 || !Array.isArray(data.projects))
		throw new Error(
			"Environment configuration needs version 1 and a projects array",
		);
	const projects = data.projects.map((raw): Project => {
		const entry = object(raw);
		keysOnly(entry, [
			"id",
			"kind",
			"repository",
			"targets",
			"defaults",
			"requires",
		]);
		const requires = entry.requires === undefined ? [] : entry.requires;
		if (!Array.isArray(requires) || requires.length > 16)
			throw new Error(
				"Requires must be an array of at most 16 infrastructure IDs",
			);
		const dependencies = requires.map(identifier);
		if (
			new Set(dependencies).size !== dependencies.length ||
			(entry.kind === "library" && dependencies.length)
		)
			throw new Error(
				"Dependencies must be distinct and belong to runnable projects",
			);
		if (
			!["app", "library", "infrastructure"].includes(String(entry.kind)) ||
			!Array.isArray(entry.targets)
		)
			throw new Error(
				"Environment project needs kind app/library/infrastructure and targets",
			);
		const repository = repositoryPath(entry.repository);
		if (!config.repositories.includes(repository))
			throw new Error(
				"Environment repository is not authorized by application configuration",
			);
		const targets = entry.targets.map(readTarget);
		if (
			entry.kind !== "infrastructure" &&
			targets.some((target) => target.queryConnection)
		)
			throw new Error(
				"Query connections belong only to declared infrastructure targets",
			);
		if (new Set(targets.map((target) => target.id)).size !== targets.length)
			throw new Error("Duplicate environment target ID");
		if (
			entry.kind === "library" &&
			targets.some((target) => target.action === "run")
		)
			throw new Error("Libraries cannot have run targets");
		if (
			entry.kind === "infrastructure" &&
			targets.some((target) => target.action !== "run")
		)
			throw new Error(
				"Infrastructure currently supports run targets only; image writes and tests need separate explicit actions",
			);
		return {
			id: identifier(entry.id),
			kind: entry.kind as Project["kind"],
			...(dependencies.length ? { requires: dependencies } : {}),
			repository,
			targets,
			...(entry.defaults === undefined
				? {}
				: { defaults: parseDefaults(entry.defaults, targets) }),
		};
	});
	if (new Set(projects.map((project) => project.id)).size !== projects.length)
		throw new Error("Duplicate environment project ID");
	validateDependencies(projects);
	return projects;
}
export function resolvePlans(
	projects: Project[],
	owner: Pick<TaskInfo, "policy" | "repository" | "workspace">,
	apps: string[],
	action: Action,
	target?: string | Selection,
): Plan[] {
	if (owner.policy !== "workspace-write")
		throw new Error(
			"Environment execution requires a workspace-write task and separate human approval",
		);
	if (!apps.length || apps.length > 16 || new Set(apps).size !== apps.length)
		throw new Error("Choose 1–16 distinct environment apps");
	const resolve = (app: string, selection: Selection): Plan => {
		const project = projects.find((project) => project.id === app);
		if (!project || project.repository !== owner.repository)
			throw new Error(
				"Environment project must belong to this task's repository",
			);
		const chosen = selectTarget(
			availableTargets(project),
			action,
			selection,
			project.defaults?.[action],
		);
		if (chosen.kubernetes && selection.replicas !== undefined) {
			if (selection.replicas > 16)
				throw new Error("Bare pod replicas must be at most 16");
		}
		const cwd = contained(owner.workspace, chosen.cwd);
		if (!fs.statSync(cwd).isDirectory())
			throw new Error(
				"Environment cwd must be an existing task workspace directory",
			);
		const composePlan = chosen.compose
			? compileCompose(owner.workspace, chosen.compose)
			: undefined;
		if (
			composePlan?.services.some((service) =>
				Object.keys(service.environment).some(
					(key) => key in chosen.secretRefs,
				),
			)
		)
			throw new Error(
				"Compose literals cannot override declared secret references",
			);
		return {
			...chosen,
			app,
			projectKind: project.kind,
			...(action === "run" && project.requires?.length
				? { requires: project.requires }
				: {}),
			workspace: owner.workspace,
			cwd,
			...(composePlan ? { composePlan } : {}),
			...(chosen.kubernetes
				? {
						kubernetes: {
							...chosen.kubernetes,
							replicas: selection.replicas ?? chosen.kubernetes.replicas,
						},
					}
				: {}),
		};
	};
	const selection = typeof target === "string" ? { target } : (target ?? {});
	const roots = apps.map((app) => resolve(app, selection));
	return action === "run"
		? expandDependencies(roots, (id) => resolve(id, {}))
		: roots;
}
