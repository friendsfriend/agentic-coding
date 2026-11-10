import fs from "node:fs";
import path from "node:path";
import { type Config, digest, object, text } from "../config.ts";
import { contained } from "../git.ts";
import type { TaskInfo } from "../state.ts";
import { targetAvailability } from "./availability.ts";
import { buildReferenceKeys } from "./build-secrets.ts";
import {
	bindComposeDiagnostics,
	compileCompose,
	compileComposeSource,
	readCompose,
} from "./compose-config.ts";
import { prepareVolumes } from "./compose-volumes.ts";
import { readContainer } from "./container-config.ts";
import {
	expandDependencies,
	qualifyBridgeExporter,
	validateDependencies,
} from "./dependencies.ts";
import type {
	DependencyWorkspace,
	DependencyWorkspaces,
} from "./dependency-workspaces.ts";
import { readEndpoints } from "./endpoint.ts";
import { readEndpointCaRefs } from "./endpoint-ca.ts";
import { captureHelmChart } from "./helm-chart.ts";
import { readEndpointAuth } from "./http-options.ts";
import { readKubernetes } from "./kubernetes-config.ts";
import {
	isShellRuntime,
	type Plan,
	type Project,
	type Target,
} from "./model.ts";
import { readQueryConnection } from "./query-config.ts";
import {
	type Action,
	defaultTargets,
	type Selection,
	selectTarget,
} from "./selection.ts";
import { readReadyUrl } from "./shell-readiness.ts";

const identifier = (value: unknown) => {
	const id = text(value, "environment identifier", 64);
	if (!/^[a-z][a-z0-9-]*$/.test(id))
		throw new Error("Invalid environment identifier");
	return id;
};
function profileName(value: unknown) {
	const profile = text(value, "environment profile", 64);
	if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(profile))
		throw new Error("Invalid environment profile");
	return profile;
}
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
function readPrerequisites(value: unknown) {
	const raw = value ?? [];
	if (!Array.isArray(raw) || raw.length > 16)
		throw new Error("At most 16 declared prerequisite edges are supported");
	const edges = raw.map((entry) => {
		const edge = object(entry);
		keysOnly(edge, ["app", "target"]);
		return { app: identifier(edge.app), target: identifier(edge.target) };
	});
	if (new Set(edges.map((edge) => edge.app)).size !== edges.length)
		throw new Error("Prerequisite edges must be distinct");
	return edges;
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
		"readyUrl",
		"environment",
		"secretRefs",
		"container",
		"compose",
		"kubernetes",
		"endpoints",
		"endpointServices",
		"queryService",
		"endpointCaRefs",
		"endpointAuthRefs",
		"queryConnection",
		"telemetry",
		"prerequisites",
	]);
	const prerequisites = readPrerequisites(data.prerequisites);
	if (prerequisites.length && data.action !== "run")
		throw new Error("Target prerequisites belong only to run actions");
	if (
		data.runtime !== "shell" &&
		data.runtime !== "systemshell" &&
		data.runtime !== "docker" &&
		data.runtime !== "podman" &&
		data.runtime !== "compose" &&
		data.runtime !== "kubernetes"
	)
		throw new Error("Unsupported environment runtime");
	if (data.runtime === "systemshell" && data.action !== "run")
		throw new Error("System POSIX interpreter targets are run-only");
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
		isShellRuntime(data.runtime)
			? data.container !== undefined
			: data.command !== undefined ||
				data.readyText !== undefined ||
				data.readyUrl !== undefined
	)
		throw new Error(
			"Shell commands/readiness and structured container configuration cannot be mixed",
		);
	if (
		(data.endpoints !== undefined ||
			data.endpointCaRefs !== undefined ||
			data.endpointAuthRefs !== undefined) &&
		(data.action !== "run" ||
			!(
				isShellRuntime(data.runtime) ||
				data.runtime === "docker" ||
				data.runtime === "podman" ||
				data.runtime === "compose" ||
				data.runtime === "kubernetes"
			))
	)
		throw new Error(
			"Named local endpoints require a shell, owned container or owned pod run target",
		);
	if (
		data.queryConnection !== undefined &&
		(data.action !== "run" ||
			!(isShellRuntime(data.runtime)
				? Boolean(data.readyText || data.readyUrl)
				: ["docker", "podman", "compose", "kubernetes"].includes(
						String(data.runtime),
					)))
	)
		throw new Error(
			"Query connections require a shell run with explicit readiness, a health-ready container run or a pod run",
		);
	const container =
		isShellRuntime(data.runtime) ||
		data.runtime === "compose" ||
		data.runtime === "kubernetes"
			? undefined
			: readContainer(data.container);
	if (!["run", "build", "test"].includes(String(data.action)))
		throw new Error("Invalid environment target action");
	if (container?.hostPreparation && data.action !== "build")
		throw new Error(
			"Host preparation belongs only to a native container image build",
		);
	if (data.action !== "run" && container?.restart && container.restart !== "no")
		throw new Error(
			"Restart policies belong only to long-lived run containers",
		);
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
		if (data.runtime === "compose") {
			keysOnly(capture, [
				"protocol",
				"listen",
				"collectorService",
				"transport",
			]);
			if (
				capture.protocol !== "otlp-http-json" ||
				capture.listen !== "0.0.0.0:0" ||
				capture.transport !== "tls-host-gateway-v1" ||
				data.action !== "run" ||
				typeof capture.collectorService !== "string" ||
				!/^[a-z][a-z0-9-]{0,62}$/.test(capture.collectorService)
			)
				throw new Error(
					"Compose telemetry requires an explicit TLS host-gateway collector service on a run target",
				);
			telemetry = {
				protocol: "otlp-http-json",
				listen: "0.0.0.0:0",
				collectorService: capture.collectorService,
				transport: "tls-host-gateway-v1",
			};
		} else {
			keysOnly(capture, ["protocol", "listen"]);
			if (
				capture.protocol !== "otlp-http-json" ||
				capture.listen !== "127.0.0.1:0" ||
				!isShellRuntime(data.runtime) ||
				data.action !== "run" ||
				!(data.readyText || data.readyUrl)
			)
				throw new Error(
					"Native telemetry requires an explicit otlp-http-json loopback-ephemeral shell run target with readiness text",
				);
			telemetry = { protocol: "otlp-http-json", listen: "127.0.0.1:0" };
		}
	}
	const environment = variables(data.environment),
		secretRefs = variables(data.secretRefs);
	if (
		telemetry &&
		[...Object.keys(environment), ...Object.keys(secretRefs)].some(
			(key) =>
				key.startsWith("AC_OTEL_") ||
				key.startsWith("OTEL_EXPORTER_OTLP_") ||
				(data.runtime === "compose" && key === "OTEL_COLLECTOR_CONFIG") ||
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
	if (
		data.readyUrl !== undefined &&
		(!isShellRuntime(data.runtime) ||
			data.action !== "run" ||
			data.readyText !== undefined)
	)
		throw new Error(
			"Shell run readiness chooses either text or a loopback URL, never both",
		);
	const readyUrl = readReadyUrl(data.readyUrl);
	if (
		container &&
		(container.dockerfileSource !== undefined || container.buildSecrets) &&
		data.action !== "build"
	)
		throw new Error(
			"Captured Dockerfiles and build secrets belong only to build actions",
		);
	for (const secret of Object.values(container?.buildSecrets ?? {}))
		if (
			buildReferenceKeys(secret).some((key) => !Object.hasOwn(secretRefs, key))
		)
			throw new Error(
				"Build secret environment/template references must name declared target secretRefs, not literals",
			);
	if (
		[...Object.keys(environment), ...Object.keys(secretRefs)].some((key) =>
			key.startsWith("ACV2_BUILD_SECRET_"),
		)
	)
		throw new Error("Native build-secret transport variables are reserved");
	const cwd = text(data.cwd ?? ".", "environment cwd", 4096);
	if (path.isAbsolute(cwd))
		throw new Error("Environment cwd must be relative to the task workspace");
	const queryConnection = readQueryConnection(data.queryConnection, secretRefs);
	if (queryConnection && container) {
		if (
			container?.readiness !== "healthy" ||
			!container.ports.some(
				(port) =>
					port.host === queryConnection.port &&
					port.address === queryConnection.host &&
					port.protocol === "tcp",
			)
		)
			throw new Error(
				"Container query connections require healthy readiness and an exact published TCP loopback host/port",
			);
	}
	const kubernetes =
			data.runtime === "kubernetes"
				? readKubernetes(data.kubernetes)
				: undefined,
		loopback = (url: URL) =>
			url.hostname === "127.0.0.1" || url.hostname === "[::1]",
		helmRelease = kubernetes?.workload === "helm-release-v1",
		forwarded = (port: number) =>
			kubernetes?.portForwards?.filter((forward) => forward.local === port)
				.length === 1,
		endpoints = readEndpoints(data.endpoints),
		endpointCaRefs = readEndpointCaRefs(data.endpointCaRefs, endpoints);
	let endpointServices: Record<string, string> | undefined;
	let queryService: string | undefined;
	if (data.endpointServices !== undefined || data.queryService !== undefined) {
		if (data.runtime !== "compose")
			throw new Error("Service selectors require a Compose run target");
	}
	if (data.runtime === "compose") {
		const bindings = object(data.endpointServices ?? {});
		if (
			Object.keys(bindings).length !== Object.keys(endpoints).length ||
			Object.entries(bindings).some(
				([name, id]) =>
					!Object.hasOwn(endpoints, name) ||
					typeof id !== "string" ||
					!/^[a-z][a-z0-9-]{0,62}$/.test(id),
			)
		)
			throw new Error(
				"Every Compose endpoint requires one explicit service selector",
			);
		endpointServices = bindings as Record<string, string>;
		if (queryConnection) {
			queryService = text(data.queryService, "Compose query service", 63);
			if (!/^[a-z][a-z0-9-]{0,62}$/.test(queryService))
				throw new Error("Invalid Compose query service selector");
		} else if (data.queryService !== undefined)
			throw new Error(
				"Compose query service requires a declared query connection",
			);
	}
	// A container endpoint is reachable only through an exact published loopback
	// port and health readiness; the declaration never becomes observation.
	if (Object.keys(endpoints).length > 0 && container) {
		if (container.readiness !== "healthy")
			throw new Error(
				"Container endpoints require health readiness, not running-only readiness",
			);
		for (const value of Object.values(endpoints)) {
			const url = new URL(value);
			if (
				!container.ports.some(
					(port) =>
						port.protocol === "tcp" &&
						port.host ===
							Number(url.port || (url.protocol === "https:" ? 443 : 80)) &&
						(port.address === url.hostname ||
							(port.address === "::1" && url.hostname === "[::1]")),
				)
			)
				throw new Error(
					"Container endpoints require an exact declared TCP loopback publication",
				);
		}
	}
	// A chart release owns its manifests, values and secrets; v2 does not bind
	// target literals, references, diagnostics or telemetry into a chart.
	if (
		helmRelease &&
		(data.endpoints !== undefined ||
			data.endpointCaRefs !== undefined ||
			data.endpointAuthRefs !== undefined ||
			data.endpointServices !== undefined ||
			data.queryService !== undefined ||
			queryConnection ||
			telemetry ||
			Object.keys(environment).length ||
			Object.keys(secretRefs).length)
	)
		throw new Error(
			"Helm release targets do not accept environment, secret references, endpoints, query connections or telemetry; chart values and native release observation are the only declared inputs",
		);
	// A pod query connection is reachable only through the one loopback forward
	// this run starts on the query port; a second forward or pod choice is never
	// inferred, and the declaration is not networking or ownership evidence.
	if (queryConnection && kubernetes && !forwarded(queryConnection.port))
		throw new Error(
			"Kubernetes query connections require exactly one declared loopback port forward on the query port",
		);
	// A pod is reachable only through the one loopback forward this run starts;
	// the declaration never becomes networking or ownership evidence.
	for (const value of kubernetes ? Object.values(endpoints) : []) {
		const url = new URL(value),
			port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		if (!loopback(url) || !forwarded(port))
			throw new Error(
				"Kubernetes endpoints require exactly one declared loopback port forward on the endpoint's own port",
			);
	}
	return {
		id: identifier(data.id),
		...(prerequisites.length ? { prerequisites } : {}),
		...(telemetry ? { telemetry } : {}),
		...(data.endpoints === undefined ? {} : { endpoints }),
		...(endpointServices ? { endpointServices } : {}),
		...(queryService ? { queryService } : {}),
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
		...(kubernetes ? { kubernetes } : {}),
		...(data.runtime === "compose"
			? { compose: readCompose(data.compose) }
			: {}),
		command: isShellRuntime(data.runtime)
			? text(data.command, "environment command", 16000)
			: "",
		...(data.profile === undefined
			? {}
			: { profile: profileName(data.profile) }),
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
		...(readyUrl ? { readyUrl } : {}),
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
			"prerequisites",
		]);
		const requires = entry.requires === undefined ? [] : entry.requires;
		if (!Array.isArray(requires) || requires.length > 16)
			throw new Error(
				"Requires must be an array of at most 16 infrastructure IDs",
			);
		const dependencies = requires.map(identifier);
		const rawPrerequisites = entry.prerequisites ?? [];
		if (
			!Array.isArray(rawPrerequisites) ||
			rawPrerequisites.length + dependencies.length > 16
		)
			throw new Error(
				"At most 16 distinct declared prerequisite edges are supported",
			);
		const prerequisites = rawPrerequisites.map((raw) => {
			const edge = object(raw);
			keysOnly(edge, ["app", "target"]);
			return { app: identifier(edge.app), target: identifier(edge.target) };
		});
		if (
			new Set([...dependencies, ...prerequisites.map((edge) => edge.app)])
				.size !==
				dependencies.length + prerequisites.length ||
			(entry.kind === "library" && prerequisites.length)
		)
			throw new Error(
				"Prerequisite edges must be distinct and belong to runnable projects",
			);
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
		for (const target of targets) {
			const selected = [
				...dependencies,
				...prerequisites.map((edge) => edge.app),
				...(target.prerequisites ?? []).map((edge) => edge.app),
			];
			if (selected.length > 16 || new Set(selected).size !== selected.length)
				throw new Error(
					"Project and target prerequisite edges must form a distinct bounded closure",
				);
		}
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
			...(prerequisites.length ? { prerequisites } : {}),
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
/** Batch-level namespace fences, checked before approval, reservation or
 * commands. Host ports are single-occupancy regardless of which mechanism
 * claims them (container publication, query listener, app endpoint binding or
 * Kubernetes loopback forward); two apps sharing one is an engine startup
 * conflict, never a queue to serialize. Same-app endpoint aliases for one URL
 * are allowed; every other duplicate binding is refused. */
function refuseBatchCollisions(plans: Plan[]) {
	const bound = new Map<string, string>();
	const claim = (key: string, app: string, detail: string) => {
		const owner = bound.get(key);
		if (owner === undefined) bound.set(key, app);
		else if (owner !== app)
			throw new Error(
				`Environment batch binds the same host port twice (${detail}); choose distinct ports before approval`,
			);
	};
	for (const plan of plans) {
		if (plan.readyUrl) {
			const url = new URL(plan.readyUrl),
				host = url.hostname.replace(/^\[|\]$/g, ""),
				port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
			claim(`tcp/${host}:${port}`, plan.app, `shell readiness ${host}:${port}`);
		}
		for (const port of plan.container?.ports ?? [])
			claim(
				`${port.protocol}/${String(port.address).toLowerCase()}:${port.host}`,
				plan.app,
				`container publication ${String(port.address)}:${port.host}`,
			);
		if (plan.queryConnection)
			claim(
				`tcp/${plan.queryConnection.host.toLowerCase()}:${plan.queryConnection.port}`,
				plan.app,
				`query listener ${plan.queryConnection.host}:${plan.queryConnection.port}`,
			);
		for (const value of Object.values(plan.endpoints ?? {})) {
			let url: URL;
			try {
				url = new URL(value);
			} catch {
				continue;
			}
			const port = Number(url.port || (url.protocol === "https:" ? 443 : 80)),
				host =
					url.hostname.toLowerCase() === "localhost"
						? "127.0.0.1"
						: url.hostname.toLowerCase();
			claim(`tcp/${host}:${port}`, plan.app, `endpoint ${host}:${port}`);
		}
		for (const forward of plan.kubernetes?.portForwards ?? [])
			claim(
				`tcp/127.0.0.1:${forward.local}`,
				plan.app,
				`port forward 127.0.0.1:${forward.local}`,
			);
	}
}
export async function resolvePlans(
	projects: Project[],
	owner: Pick<TaskInfo, "policy" | "repository" | "workspace"> & {
		id?: number;
	},
	apps: string[],
	action: Action,
	target?: string | Selection,
	stateDir?: string,
	workspaces?: DependencyWorkspaces,
): Promise<Plan[]> {
	if (owner.policy !== "workspace-write")
		throw new Error(
			"Environment execution requires a workspace-write task and separate human approval",
		);
	if (!apps.length || apps.length > 16 || new Set(apps).size !== apps.length)
		throw new Error("Choose 1–16 distinct environment apps");
	const selection = typeof target === "string" ? { target } : (target ?? {});
	const selectedTargets = new Map<string, Target>();
	const scopes = new Map<string, DependencyWorkspace>();
	for (const app of apps)
		if (
			projects.find((project) => project.id === app)?.repository !==
			owner.repository
		)
			throw new Error(
				"Environment root project must belong to this task's repository",
			);
	if (action === "run") {
		const visited = new Set<string>();
		const inspect = async (id: string, choice: Selection): Promise<void> => {
			const project = projects.find((project) => project.id === id);
			if (!project) throw new Error("Missing declared prerequisite project");
			const chosen = selectTarget(
				availableTargets(project),
				action,
				choice,
				project.defaults?.[action],
			);
			if (visited.has(id)) {
				if (selectedTargets.get(id)?.id !== chosen.id)
					throw new Error(
						"Prerequisite graph selects conflicting targets for one project",
					);
				return;
			}
			if (visited.size >= 16)
				throw new Error("Expanded environment batch exceeds 16 projects");
			visited.add(id);
			selectedTargets.set(id, chosen);
			if (project.repository !== owner.repository) {
				if (!workspaces || !stateDir)
					throw new Error(
						"Foreign prerequisites require native dependency-workspace authority",
					);
				if (!scopes.has(project.repository))
					scopes.set(
						project.repository,
						await workspaces.describe(
							project.repository,
							owner.workspace,
							owner.id,
						),
					);
			}
			for (const id of project.requires ?? []) await inspect(id, {});
			for (const edge of [
				...(project.prerequisites ?? []),
				...(chosen.prerequisites ?? []),
			])
				await inspect(edge.app, { target: edge.target });
		};
		for (const app of apps) await inspect(app, selection);
	}
	const resolve = (app: string, selection: Selection): Plan => {
		const project = projects.find((project) => project.id === app);
		if (
			!project ||
			(project.repository !== owner.repository &&
				!scopes.has(project.repository))
		)
			throw new Error("Project is outside the approved prerequisite closure");
		const scope = scopes.get(project.repository),
			workspace = scope?.workspace ?? owner.workspace;
		const chosen =
			selectedTargets.get(app) ??
			selectTarget(
				availableTargets(project),
				action,
				selection,
				project.defaults?.[action],
			);
		if (chosen.kubernetes && selection.replicas !== undefined) {
			if (selection.replicas > 16)
				throw new Error("Bare pod replicas must be at most 16");
			if (
				chosen.kubernetes.workload === "helm-release-v1" &&
				!chosen.kubernetes.helm.replicasValuePath
			)
				throw new Error(
					"Helm replica requests require an explicit replicasValuePath; chart defaults are not guessed",
				);
		}
		if (scope && chosen.kubernetes)
			throw new Error(
				"Foreign Kubernetes prerequisites require a repository-scoped cluster authorization; not inferred from the root",
			);
		if (scope && chosen.compose && chosen.compose.source === undefined)
			throw new Error(
				"Foreign Compose prerequisites require config-captured source; developer checkout source bytes are never imported",
			);
		const checkedCwd = contained(
			scope ? project.repository : workspace,
			chosen.cwd,
		);
		const cwd = scope ? path.resolve(workspace, chosen.cwd) : checkedCwd;
		if (!fs.statSync(checkedCwd).isDirectory())
			throw new Error(
				"Environment cwd must be an existing task workspace directory",
			);
		const composePlan = chosen.compose
			? bindComposeDiagnostics(
					chosen,
					scope
						? compileComposeSource(project.repository, chosen.compose, {
								source: chosen.compose.source ?? "",
								contentDigest: digest(
									Buffer.from(chosen.compose.source ?? "").toString("base64"),
								),
							})
						: compileCompose(workspace, chosen.compose),
				)
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
		const prerequisites = [
			...(project.prerequisites ?? []),
			...(chosen.prerequisites ?? []),
		];
		return qualifyBridgeExporter(projects, {
			...chosen,
			app,
			projectKind: project.kind,
			...(action === "run" &&
			(project.requires?.length ?? 0) + prerequisites.length
				? {
						requires: [
							...(project.requires ?? []),
							...prerequisites.map((edge) => edge.app),
						],
						...(prerequisites.length
							? {
									prerequisiteTargets: Object.fromEntries(
										prerequisites.map((edge) => [edge.app, edge.target]),
									),
								}
							: {}),
					}
				: {}),
			...(scope ? { dependencyWorkspace: scope } : {}),
			workspace,
			cwd,
			...(composePlan ? { composePlan } : {}),
			...(chosen.kubernetes?.workload === "helm-release-v1"
				? {
						kubernetes: {
							...chosen.kubernetes,
							helm: {
								...chosen.kubernetes.helm,
								...(selection.replicas === undefined
									? {}
									: { replicas: selection.replicas }),
							},
						},
						helmChart: captureHelmChart(checkedCwd, chosen.kubernetes.helm),
					}
				: chosen.kubernetes
					? {
							kubernetes: {
								...chosen.kubernetes,
								replicas: selection.replicas ?? chosen.kubernetes.replicas,
							},
						}
					: {}),
		});
	};
	const roots = apps.map((app) => resolve(app, selection));
	const plans =
		action === "run"
			? expandDependencies(roots, (id, parent) =>
					resolve(
						id,
						parent.prerequisiteTargets?.[id]
							? { target: parent.prerequisiteTargets[id] }
							: {},
					),
				)
			: roots;
	if (plans.some((plan) => plan.composePlan?.volumes?.length) && !stateDir)
		throw new Error(
			"Native volume preparation requires an explicit host state scope",
		);
	const prepared = stateDir
		? plans.map((plan) => prepareVolumes(plan, stateDir))
		: plans;
	refuseBatchCollisions(prepared);
	const volumeScopes = new Set<string>();
	for (const plan of prepared)
		for (const volume of plan.composePlan?.volumes ?? []) {
			let socket = plan.compose?.socket ?? "";
			try {
				socket = fs.realpathSync(socket);
			} catch {
				socket = path.resolve(socket);
			}
			const key = JSON.stringify([socket, volume.scope]);
			if (volumeScopes.has(key))
				throw new Error(
					"Environment batch attaches the same native volume scope twice; use one owned prerequisite",
				);
			volumeScopes.add(key);
		}
	return prepared;
}
