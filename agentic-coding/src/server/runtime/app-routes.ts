// Application and infrastructure route handlers
// (`port-environment-runtimes-to-bun`, task 4.4).
//
// Ported from `server/pkg/server/{handlers_apps,handlers_build,
// handlers_infra_scripts}.go`.
//
// The Bun environment authority already owns the catalog, so these routes read
// the loaded configuration rather than re-parsing files. Status is assembled
// from live observations: the container runtime, Git, Kubernetes/script
// providers and the transient operation status. A runtime that cannot be
// observed reports uncertainty; it never reports confirmed absence.

import fs from "node:fs";
import {
	discoverProfiles,
	resolveDockerfileForAction,
} from "../actions/discovery.ts";
import type { App, InfraService, Project } from "../environment/config.ts";
import { newProjectCatalog } from "../environment/config.ts";
import { generateExampleConfig } from "../environment/example-config.ts";
import type { DockerInfo, DockerRuntimeSelection } from "./docker.ts";
import type { LegacyRuntimeEvent } from "./routes.ts";
import {
	dockerRuntimeStatus,
	normalize,
	type RuntimeCandidate,
	type RuntimeStatus,
	runtimeStatusString,
	type StatusManager,
	selectStatus,
} from "./status.ts";

export interface AppFamilyServices {
	readonly docker?: DockerRuntimeSelection;
	readonly configDir: string;
	readonly homeDir: string;
	readonly apps: () => readonly App[];
	readonly infraServices: () => readonly InfraService[];
	readonly getAppByIdent: (ident: string) => App | undefined;
	readonly getInfraServiceByIdent: (ident: string) => InfraService | undefined;
	readonly getDisplayName: (ident: string) => string;
	/** The catalog projection `GET /api/projects` serves. */
	readonly getProjectCatalog: () => readonly Project[];
	/** Static per-service fields, when the owner wants to extend the row. */
	readonly describeInfraService?: (
		service: InfraService,
	) => Record<string, unknown>;
	readonly git: {
		getCurrentBranch(app: App): string;
		getStatus(app: App): string;
	};
	/** Branch refresh and reload after a create/delete. */
	readonly loadConfig: () => void;
	readonly addApp: (app: App) => void;
	readonly removeApp: (ident: string, deleteDir: boolean) => void;
	readonly setMainWorktreeBranch: (ident: string, branch: string) => void;
	/** Runs the initial clone for a newly created app. */
	readonly cloneApp?: (app: App) => void;
	readonly providers: {
		get(name: string): { name: string; type: string } | undefined;
	};
	readonly statusManager: StatusManager;
	/** Script infrastructure state, when a script lifecycle owner is attached. */
	readonly scriptStatus?: (ident: string) => Promise<ScriptStatusShape>;
	/** Kubernetes infrastructure state, when the cluster capability is attached. */
	readonly kubernetesStatus?: (service: InfraService) => string;
	/** The last-run runtime/kubernetes observations for an app. */
	readonly runObservation?: (ident: string) => Promise<RunObservationShape>;
	readonly stream?: { publish(event: LegacyRuntimeEvent): void };
	readonly publish?: (event: LegacyRuntimeEvent) => void;
	readonly now?: () => Date;
	readonly logger?: (message: string) => void;
}

const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	404: "Not Found",
	405: "Method Not Allowed",
	409: "Conflict",
	500: "Internal Server Error",
	503: "Service Unavailable",
};

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function error(status: number, message: string): Response {
	return json(
		{ error: STATUS_TEXT[status] ?? "Error", message, code: status },
		status,
	);
}

function text(value: string): Response {
	return new Response(value, {
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

/** The legacy envelope a mutating route answers with. */
function success(message?: string): Response {
	return json(
		message === undefined ? { success: true } : { success: true, message },
	);
}

export interface AppFamilyRoute {
	readonly method: string;
	readonly path: string;
	/** Captures the `{ident}` segment, when the path has one. */
	readonly ident?: string;
}

/**
 * Matches one app-family row. Kept here (rather than in the manifest) because
 * the rows carry the legacy multi-method behaviour the manifest cannot express:
 * `/api/apps/{ident}/profiles` is GET-only, `/api/providers` handles all verbs.
 */
export function matchAppRoute(
	method: string,
	pathname: string,
): AppFamilyRoute | undefined {
	const routes: { method: string; pattern: string }[] = [
		{ method: "GET", pattern: "/api/apps" },
		{ method: "GET", pattern: "/api/projects" },
		{ method: "GET", pattern: "/api/status" },
		{ method: "GET", pattern: "/api/infra-services" },
		{ method: "GET", pattern: "/api/infra-services/{ident}/logs" },
		{ method: "GET", pattern: "/api/apps/{ident}/docker" },
		{ method: "GET", pattern: "/api/apps/{ident}/git" },
		{ method: "GET", pattern: "/api/apps/{ident}/profiles" },
		{ method: "POST", pattern: "/api/apps/create" },
		{ method: "POST", pattern: "/api/example-config" },
		{ method: "DELETE", pattern: "/api/apps/{ident}/delete" },
	];
	for (const route of routes) {
		if (route.method !== method) continue;
		const ident = matchPattern(route.pattern, pathname);
		if (ident === null) continue;
		return {
			method,
			path: route.pattern,
			...(ident === "" ? {} : { ident }),
		};
	}
	return undefined;
}

/** `null` when the path does not match; `""` when the pattern has no capture. */
function matchPattern(pattern: string, pathname: string): string | null {
	const patternParts = pattern.split("/");
	const pathParts = pathname.split("/");
	if (patternParts.length !== pathParts.length) return null;
	let ident = "";
	for (let i = 0; i < patternParts.length; i++) {
		const expected = patternParts[i];
		const actual = pathParts[i];
		if (expected === "{ident}") {
			if (actual === "") return null;
			ident = decodeURIComponent(actual);
			continue;
		}
		if (expected !== actual) return null;
	}
	return ident;
}

/** Serves one app-family row. */
export async function handleAppRoute(
	services: AppFamilyServices,
	request: Request,
	url: URL,
): Promise<Response | undefined> {
	const match = matchAppRoute(request.method.toUpperCase(), url.pathname);
	if (!match) return undefined;
	switch (match.path) {
		case "/api/apps":
			return listApps(services);
		case "/api/projects":
			// The catalog envelope (revision + projects) is what the client compares
			// to detect a configured-project change; returning only the entries would
			// silently disable that change detection.
			return json(newProjectCatalog([...services.getProjectCatalog()]));
		case "/api/status":
			return statusAll(services);
		case "/api/infra-services":
			return listInfraServices(services);
		case "/api/infra-services/{ident}/logs":
			return infraLogs(services, match.ident ?? "");
		case "/api/apps/{ident}/docker":
			return appDocker(services, match.ident ?? "");
		case "/api/apps/{ident}/git":
			return appGit(services, match.ident ?? "");
		case "/api/apps/{ident}/profiles":
			return appProfiles(services, match.ident ?? "");
		case "/api/apps/create":
			return createApp(services, request);
		case "/api/example-config":
			return createExampleConfig(services);
		case "/api/apps/{ident}/delete":
			return deleteApp(services, match.ident ?? "");
		default:
			return undefined;
	}
}

// --- reads ----------------------------------------------------------------

function listApps(services: AppFamilyServices): Response {
	const apps = services.apps().map((app) => ({
		ident: app.ident,
		displayName: app.displayName,
		localDirectoryPath: app.localDirectoryPath,
		repositoryPath: app.repositoryPath,
		branch: app.branch,
		appType: app.appType,
		containerBaseName: app.containerBaseName ?? app.ident,
		...(resolveSourceType(services, app) !== ""
			? { sourceType: resolveSourceType(services, app) }
			: {}),
		...(app.provider ? { provider: app.provider } : {}),
		...(app.activeWorktree ? { activeWorktree: app.activeWorktree } : {}),
		...(app.mainWorktreeBranch
			? { mainWorktreeBranch: app.mainWorktreeBranch }
			: {}),
	}));
	return json({ apps });
}

/** Provider type, then the configured source type, then the repository host. */
function resolveSourceType(services: AppFamilyServices, app: App): string {
	if (app.provider !== undefined && app.provider !== "") {
		const provider = services.providers.get(app.provider);
		if (provider?.type) return provider.type;
	}
	if (app.sourceType) return app.sourceType;
	return app.repositoryPath.toLowerCase().includes("github.com")
		? "github"
		: "";
}

async function statusAll(services: AppFamilyServices): Promise<Response> {
	const apps = services.apps();
	const containerTargets = apps
		.filter((app) => app.appType === "app")
		.map((app) => ({
			ident: app.ident,
			containerBaseName: app.containerBaseName ?? app.ident,
		}));
	let dockerInfo = new Map<string, DockerInfo>();
	if (services.docker && containerTargets.length > 0) {
		dockerInfo = await services.docker.client.batchGetInfo(
			containerTargets,
			[],
		);
	}
	const statuses = [];
	for (const app of apps) {
		const info = dockerInfo.get(app.ident);
		const observed: DockerInfo = info ?? {
			Status: "not found",
			ContainerID: "",
			Ports: "",
		};
		// The observation is awaited once per app: it probes tmux and the cluster,
		// and a library has no runtime to observe.
		const observation =
			app.appType === "library"
				? undefined
				: await services.runObservation?.(app.ident);
		statuses.push(
			await appStatusProperties(services, app, observed, observation),
		);
	}
	return json({ statuses });
}

/**
 * One app's status properties. The status route and the status broadcaster read
 * this one implementation, so a live push and a polled read can never disagree.
 */
export async function appStatusProperties(
	services: AppFamilyServices,
	app: App,
	dockerInfo: DockerInfo,
	observation?: RunObservationShape,
): Promise<Record<string, unknown>> {
	const observed =
		observation === undefined
			? await services.runObservation?.(app.ident)
			: observation;
	const runtimeStatus =
		app.appType === "library"
			? undefined
			: appRuntimeStatus(observed, dockerInfo);
	const opStatus = operationStatus(services, app.ident);
	return {
		ident: app.ident,
		resourceId: app.ident,
		resourceKind: app.appType === "library" ? "library" : "app",
		...(dockerInfo.Status === "" ? {} : { dockerInfo }),
		gitStatus: services.git.getStatus(app),
		branch: services.git.getCurrentBranch(app),
		...(app.activeWorktree ? { activeWorktree: app.activeWorktree } : {}),
		...(opStatus === undefined ? {} : { operationStatus: opStatus }),
		runtimeStatus,
		...(runtimeStatus ? { status: runtimeStatusString(runtimeStatus) } : {}),
		...(observed?.runTargetInfo === undefined
			? { runTargetInfo: null }
			: { runTargetInfo: observed.runTargetInfo }),
	};
}

/** One infrastructure service's status properties (see `appStatusProperties`). */
export async function infraStatusProperties(
	services: AppFamilyServices,
	service: InfraService,
	dockerInfo?: DockerInfo,
): Promise<Record<string, unknown>> {
	const snapshot = await infraStatus(services, service, dockerInfo);
	const opStatus = operationStatus(services, service.ident);
	return {
		ident: service.ident,
		resourceId: service.ident,
		resourceKind: "infrastructure",
		...(snapshot.dockerInfo ? { dockerInfo: snapshot.dockerInfo } : {}),
		runtimeStatus: snapshot.runtimeStatus,
		status: runtimeStatusString(snapshot.runtimeStatus),
		...(snapshot.logPath ? { logPath: snapshot.logPath } : {}),
		...(opStatus === undefined ? {} : { operationStatus: opStatus }),
		...(snapshot.executionHandle !== undefined
			? { executionHandle: snapshot.executionHandle }
			: {}),
	};
}

/** The wire shape Go's `OperationStatus` marshalled: three fields, no more. */
export interface OperationStatusResponse {
	readonly operation: string;
	readonly status: string;
	readonly message: string;
}

function operationStatus(
	services: AppFamilyServices,
	ident: string,
): OperationStatusResponse | undefined {
	const status = services.statusManager.getStatus(ident);
	if (!status) return undefined;
	return {
		operation: status.operation,
		status: status.status,
		message: status.message,
	};
}

/**
 * The app's live runtime status: every observation is a candidate and the
 * highest-ranked one wins, so a runtime name or last-run cache never hides a
 * running target.
 */
export function appRuntimeStatus(
	observation: RunObservationShape | undefined,
	dockerInfo: DockerInfo,
): RuntimeStatus {
	const candidates: RuntimeCandidate[] = [
		{ source: "container", status: dockerRuntimeStatus(dockerInfo.Status) },
	];
	if (observation?.kubernetesStatus) {
		candidates.push({
			source: "kubernetes",
			status: observation.kubernetesStatus,
		});
	}
	if (
		observation?.lastRunRuntime !== undefined &&
		["shell", "powershell", "systemshell"].includes(
			observation.lastRunRuntime,
		) &&
		observation.shellTmuxRunActive
	) {
		candidates.push({ source: "shell", status: "running" });
	}
	return selectStatus(candidates);
}

async function listInfraServices(
	services: AppFamilyServices,
): Promise<Response> {
	const infraServices = services.infraServices();
	const dockerTargets = infraServices
		.filter((service) => service.type === "" || service.type === "docker")
		.map((service) => ({
			ident: service.ident,
			containerBaseName: service.containerBaseName ?? service.ident,
		}));
	let dockerInfo = new Map<string, DockerInfo>();
	if (services.docker && dockerTargets.length > 0) {
		dockerInfo = await services.docker.client.batchGetInfo([], dockerTargets);
	}
	const responses = [];
	for (const service of infraServices) {
		responses.push({
			...services.describeInfraService?.(service),
			...(await infraStatusProperties(
				services,
				service,
				dockerInfo.get(service.ident),
			)),
			displayName: service.displayName,
			...(service.type ? { type: service.type } : {}),
			containerBaseName: service.containerBaseName ?? service.ident,
			...(service.shellPath ? { shellPath: service.shellPath } : {}),
			...(service.powerShellPath
				? { powerShellPath: service.powerShellPath }
				: {}),
			...(service.defaultRunner
				? { defaultRunner: service.defaultRunner }
				: {}),
		});
	}
	return json({ services: responses });
}

/** The live observations one app's runtime status is selected from. */
export interface RunObservationShape {
	readonly kubernetesStatus?: string;
	readonly lastRunRuntime?: string;
	readonly shellTmuxRunActive?: boolean;
	readonly runTargetInfo?: unknown;
}

/** The script lifecycle owner's status shape, kept structural on purpose. */
export interface ScriptStatusShape {
	readonly status: string;
	readonly logPath: string;
	readonly executionHandle?: unknown;
}

export interface InfraStatusSnapshot {
	runtimeStatus: RuntimeStatus;
	dockerInfo?: DockerInfo;
	logPath?: string;
	executionHandle?: unknown;
}

/** Infrastructure status by type: script, Kubernetes, or the container runtime. */
export async function infraStatus(
	services: Pick<
		AppFamilyServices,
		"docker" | "scriptStatus" | "kubernetesStatus"
	>,
	service: InfraService,
	dockerInfo?: DockerInfo,
): Promise<InfraStatusSnapshot> {
	if (service.type === "script") {
		const observed = await services.scriptStatus?.(service.ident);
		if (!observed) {
			// No script lifecycle owner is attached: report the configured
			// service state rather than inventing a running one.
			return {
				runtimeStatus: normalize(service.status ?? ""),
				...(service.logPath ? { logPath: service.logPath } : {}),
			};
		}
		return {
			runtimeStatus: normalize(observed.status),
			logPath: observed.logPath,
			...(observed.executionHandle !== undefined
				? { executionHandle: observed.executionHandle }
				: {}),
		};
	}
	if (service.type === "kubernetes") {
		const observed = services.kubernetesStatus?.(service);
		return {
			runtimeStatus: observed ? normalize(observed) : { state: "stopped" },
		};
	}
	const info = dockerInfo ?? {
		Status: "not found",
		ContainerID: "",
		Ports: "",
	};
	return {
		runtimeStatus: normalize(dockerRuntimeStatus(info.Status)),
		dockerInfo: info,
	};
}

async function infraLogs(
	services: AppFamilyServices,
	ident: string,
): Promise<Response> {
	const service = services.getInfraServiceByIdent(ident);
	if (service?.type !== "script") {
		return error(404, "Script infrastructure service not found");
	}
	const observed = await services.scriptStatus?.(ident);
	const logPath = observed?.logPath ?? service.logPath ?? "";
	if (logPath === "") {
		return error(404, "No script log path available");
	}
	try {
		return text(fs.readFileSync(logPath, "utf8"));
	} catch (readError) {
		return error(
			500,
			`Failed to read script log: ${readError instanceof Error ? readError.message : String(readError)}`,
		);
	}
}

async function appDocker(
	services: AppFamilyServices,
	ident: string,
): Promise<Response> {
	const app = services.getAppByIdent(ident);
	if (!app) return error(404, "App not found");
	if (!services.docker) {
		// The runtime is unavailable: report uncertainty, not absence.
		return json({ Status: "error", ContainerID: "", Ports: "" });
	}
	return json(
		await services.docker.client.getInfo({
			ident: app.ident,
			containerBaseName: app.containerBaseName ?? app.ident,
		}),
	);
}

function appGit(services: AppFamilyServices, ident: string): Response {
	const app = services.getAppByIdent(ident);
	if (!app) return error(404, "App not found");
	return json({
		branch: services.git.getCurrentBranch(app),
		status: services.git.getStatus(app),
	});
}

function appProfiles(services: AppFamilyServices, ident: string): Response {
	const app = services.getAppByIdent(ident);
	if (!app) {
		// An infrastructure service has no profiles, but the picker still needs
		// `hasDockerfile: true` so it can offer the default (no profile) choice.
		if (services.getInfraServiceByIdent(ident)) {
			return json({ profiles: [], hasDockerfile: true });
		}
		return error(404, "App not found");
	}
	let profiles: string[];
	try {
		profiles = discoverProfiles(services.configDir, app.ident);
	} catch (discoverError) {
		return error(
			500,
			discoverError instanceof Error
				? discoverError.message
				: String(discoverError),
		);
	}
	const hasDockerfile =
		resolveDockerfileForAction(services.configDir, app.ident, "build") !==
		undefined;
	return json({ profiles, hasDockerfile });
}

// --- mutations ------------------------------------------------------------

interface CreateAppBody {
	displayName?: unknown;
	repositoryURL?: unknown;
	branch?: unknown;
	provider?: unknown;
	definitionLocation?: unknown;
}

async function createApp(
	services: AppFamilyServices,
	request: Request,
): Promise<Response> {
	let body: CreateAppBody;
	try {
		body = (await request.json()) as CreateAppBody;
	} catch (parseError) {
		return error(
			400,
			`Invalid request body: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
		);
	}
	const displayName = stringOf(body.displayName).trim();
	const repositoryURL = stringOf(body.repositoryURL).trim();
	const branch = stringOf(body.branch).trim();
	const providerName = stringOf(body.provider).trim();
	if (
		displayName === "" ||
		repositoryURL === "" ||
		branch === "" ||
		providerName === ""
	) {
		return error(
			400,
			"displayName, repositoryURL, branch and provider are required",
		);
	}
	const provider = services.providers.get(providerName);
	if (!provider) {
		return error(404, `Provider ${JSON.stringify(providerName)} not found`);
	}
	const ident = slugify(displayName);
	if (ident === "") {
		return error(
			400,
			"displayName must contain at least one alphanumeric character",
		);
	}
	const appType =
		stringOf(body.definitionLocation) === "libraries" ? "library" : "app";
	const newApp: App = {
		ident,
		displayName,
		repositoryPath: repositoryURL,
		appType,
		provider: providerName,
		localDirectoryPath: "",
		branch,
		mainWorktreeBranch: branch,
		activeWorktree: branch,
	};
	try {
		services.addApp(newApp);
	} catch (addError) {
		return error(
			409,
			addError instanceof Error ? addError.message : String(addError),
		);
	}
	// Seed the main worktree branch before the reload resolves the worktree
	// path, so the app points at its primary directory instead of a linked one.
	try {
		services.setMainWorktreeBranch(ident, branch);
	} catch (seedError) {
		services.logger?.(
			`[WARN] devenv: failed to seed MainWorktreeBranch for new app ${ident}: ${
				seedError instanceof Error ? seedError.message : String(seedError)
			}`,
		);
	}
	services.loadConfig();
	const created = services.getAppByIdent(ident);
	if (created && services.cloneApp) {
		try {
			services.cloneApp(created);
		} catch (cloneError) {
			services.logger?.(
				`[WARN] devenv: clone failed for ${ident}: ${
					cloneError instanceof Error ? cloneError.message : String(cloneError)
				}`,
			);
		}
	}
	publish(services, "apps.updated", { action: "created", ident });
	return json({ ...newApp, sourceType: provider.type }, 201);
}

/**
 * Writes the example configuration tree. A refusal (non-empty directory) is the
 * legacy 409 `{error}` envelope, and the configuration is only reloaded once the
 * tree was written.
 */
function createExampleConfig(services: AppFamilyServices): Response {
	try {
		generateExampleConfig({
			configDir: services.configDir,
			homeDir: services.homeDir,
		});
	} catch (generateError) {
		return json(
			{
				error:
					generateError instanceof Error
						? generateError.message
						: String(generateError),
			},
			409,
		);
	}
	try {
		services.loadConfig();
	} catch (reloadError) {
		services.logger?.(
			`[WARN] Failed to reload app config after example generation: ${
				reloadError instanceof Error ? reloadError.message : String(reloadError)
			}`,
		);
		return error(
			500,
			reloadError instanceof Error ? reloadError.message : String(reloadError),
		);
	}
	return json({ ok: true });
}

function deleteApp(services: AppFamilyServices, ident: string): Response {
	if (ident === "") return error(400, "Missing app identifier");
	try {
		services.removeApp(ident, true);
	} catch (removeError) {
		return error(
			404,
			removeError instanceof Error ? removeError.message : String(removeError),
		);
	}
	services.loadConfig();
	publish(services, "apps.updated", { action: "deleted", ident });
	return success("App removed successfully");
}

function publish(
	services: AppFamilyServices,
	type: string,
	properties: Record<string, unknown>,
): void {
	const event: LegacyRuntimeEvent = {
		type,
		properties,
		timestamp: (services.now?.() ?? new Date()).toISOString(),
	};
	services.stream?.publish(event);
	services.publish?.(event);
}

/** The ident a display name slugs to, as Go's slugify did. */
export function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function stringOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}
