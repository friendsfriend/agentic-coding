// Configured environment model: app/library and infrastructure-service
// definitions plus the canonical project-catalog projection.
//
// Ported from `server/pkg/app/manager.go` and `server/pkg/app/catalog.go`
// (`port-project-catalog-and-state-to-bun`, task 2.1). This module is pure:
// every filesystem or Git question is asked through an injected observation
// port, so the projection and its diagnostics are testable without touching a
// real checkout. Static configuration fields and runtime state fields stay
// deliberately separate — runtime state is never written into a definition
// file.

export const APP_TYPE_APP = "APP";
export const APP_TYPE_LIBRARY = "LIB";

export const GIT_MODE_BRANCH = "BRANCH";
export const GIT_MODE_WORKTREE = "WORKTREE";

export const INFRA_TYPE_DOCKER = "docker";
export const INFRA_TYPE_SCRIPT = "script";
export const INFRA_TYPE_KUBERNETES = "kubernetes";
export const SCRIPT_RUNNER_SHELL = "shell";
export const SCRIPT_RUNNER_POWERSHELL = "powershell";
export const INFRA_STATUS_STOPPED = "stopped";
export const INFRA_STATUS_RUNNING = "running";
export const INFRA_STATUS_FAILED = "failed";

export interface ExecutionHandle {
	mode: string;
	paneId?: string;
	pid?: number;
	runner?: string;
	startedAt?: string;
	exitCode?: number;
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
	displayName: string;
	ident: string;
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
	executionHandle?: ExecutionHandle;
	kubernetes?: KubernetesInfra;
}

/** An application or library as the catalog sees it.
 *
 * `ident`, `displayName`, `repositoryPath`, `appType`, `containerBaseName`,
 * `sourceType`, `provider` and `gitMode` come from the definition file;
 * `localDirectoryPath`, `branch`, `activeWorktree` and `mainWorktreeBranch`
 * are runtime state and are never persisted into it.
 */
export interface App {
	ident: string;
	displayName: string;
	repositoryPath: string;
	appType: string;
	containerBaseName?: string;
	sourceType?: string;
	provider?: string;
	gitMode?: string;
	localDirectoryPath: string;
	branch: string;
	activeWorktree?: string;
	mainWorktreeBranch?: string;
}

/** The on-disk definition of an app or library: static configuration only. */
export interface AppConfigFile {
	ident?: string;
	displayName?: string;
	repositoryPath?: string;
	containerBaseName?: string;
	sourceType?: string;
	provider?: string;
	gitMode?: string;
}

export class EnvironmentConfigError extends Error {
	readonly code = "environment-config";
	constructor(message: string) {
		super(message);
		this.name = "EnvironmentConfigError";
	}
}

/** Every diagnostic is addressed to the definition file it came from. */
function configError(fileName: string, detail: string): EnvironmentConfigError {
	return new EnvironmentConfigError(`${fileName}: ${detail}`);
}

/**
 * Parse one app/library definition file. Unparseable content fails the whole
 * load (the previous snapshot must stay intact rather than a partial one being
 * published), and runtime fields present in the file are ignored, not adopted.
 */
export function parseAppDefinition(
	fileName: string,
	raw: string,
	defaultType: string,
): App {
	let cfg: AppConfigFile;
	try {
		cfg = JSON.parse(raw) as AppConfigFile;
	} catch (error) {
		throw configError(
			fileName,
			`invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg))
		throw configError(fileName, "expected a JSON object");
	return {
		ident: cfg.ident || fileName.replace(/\.json$/, ""),
		displayName: cfg.displayName ?? "",
		repositoryPath: cfg.repositoryPath ?? "",
		appType: defaultType,
		containerBaseName: cfg.containerBaseName,
		sourceType: cfg.sourceType,
		provider: cfg.provider,
		gitMode: cfg.gitMode,
		localDirectoryPath: "",
		branch: "",
	};
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder an infrastructure definition may contain
const CONFIG_PLACEHOLDER = "${CONFIG}";

/** Expand the `${CONFIG}`/`$CONFIG` placeholders an infra definition may use.
 * Absent fields stay absent (mirroring the `omitempty` JSON contract) instead
 * of being materialized as `undefined` keys. */
export function expandInfraConfigPaths(
	service: InfraService,
	configDir: string,
): InfraService {
	const expand = (value: string | undefined): string | undefined =>
		value === undefined
			? undefined
			: value
					.replaceAll(CONFIG_PLACEHOLDER, configDir)
					.replaceAll("$CONFIG", configDir);
	const expanded: InfraService = { ...service };
	for (const key of [
		"shellPath",
		"powerShellPath",
		"cwd",
		"logPath",
	] as const) {
		const value = expand(service[key]);
		if (value === undefined) delete expanded[key];
		else expanded[key] = value;
	}
	if (expanded.kubernetes) {
		const kubernetes: KubernetesInfra = { ...expanded.kubernetes };
		const chartPath = expand(kubernetes.chartPath);
		if (chartPath === undefined) delete kubernetes.chartPath;
		else kubernetes.chartPath = chartPath;
		if (kubernetes.values)
			kubernetes.values = kubernetes.values.map((value) => expand(value) ?? "");
		expanded.kubernetes = kubernetes;
	}
	return expanded;
}

/**
 * Validate one infrastructure definition and fill in its defaults, mirroring
 * the Go normalization exactly (including which type fails which field).
 */
export function normalizeInfraService(service: InfraService): InfraService {
	const normalized: InfraService = { ...service };
	if (!normalized.ident?.trim())
		throw new Error("infra service ident is required");
	const type = normalized.type?.trim() ? normalized.type : INFRA_TYPE_DOCKER;
	normalized.type = type;
	switch (type) {
		case INFRA_TYPE_DOCKER:
			return normalized;
		case INFRA_TYPE_SCRIPT: {
			const shellPath = normalized.shellPath?.trim() ?? "";
			const powerShellPath = normalized.powerShellPath?.trim() ?? "";
			if (!shellPath && !powerShellPath)
				throw new Error(
					`script service ${JSON.stringify(normalized.ident)} requires shellPath or powerShellPath`,
				);
			const runner = normalized.defaultRunner;
			if (
				runner &&
				runner !== SCRIPT_RUNNER_SHELL &&
				runner !== SCRIPT_RUNNER_POWERSHELL
			)
				throw new Error(
					`script service ${JSON.stringify(normalized.ident)} defaultRunner must be "shell" or "powershell"`,
				);
			if (runner === SCRIPT_RUNNER_SHELL && !shellPath)
				throw new Error(
					`script service ${JSON.stringify(normalized.ident)} defaultRunner shell requires shellPath`,
				);
			if (runner === SCRIPT_RUNNER_POWERSHELL && !powerShellPath)
				throw new Error(
					`script service ${JSON.stringify(normalized.ident)} defaultRunner powershell requires powerShellPath`,
				);
			if (!normalized.status) normalized.status = INFRA_STATUS_STOPPED;
			return normalized;
		}
		case INFRA_TYPE_KUBERNETES: {
			if (!normalized.kubernetes)
				throw new Error(
					`kubernetes service ${JSON.stringify(normalized.ident)} requires kubernetes config`,
				);
			const kubernetes: KubernetesInfra = { ...normalized.kubernetes };
			if (!kubernetes.chartPath?.trim())
				throw new Error(
					`kubernetes service ${JSON.stringify(normalized.ident)} requires chartPath`,
				);
			kubernetes.profile ||= "local";
			kubernetes.release ||= normalized.ident;
			kubernetes.namespace ||= "default";
			normalized.kubernetes = kubernetes;
			if (!normalized.status) normalized.status = INFRA_STATUS_STOPPED;
			return normalized;
		}
		default:
			throw new Error(`unsupported infra service type ${JSON.stringify(type)}`);
	}
}

/** Parse one infrastructure definition file (paths still unexpanded). */
export function parseInfraDefinition(
	fileName: string,
	raw: string,
): InfraService {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw configError(
			fileName,
			`invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw configError(fileName, "expected a JSON object");
	const service = parsed as InfraService;
	if (!service.ident) service.ident = fileName.replace(/\.json$/, "");
	return service;
}

/** The static-configuration part of an app, as written back to disk. */
export function appConfigFileOf(app: App): AppConfigFile {
	const cfg: AppConfigFile = {
		ident: app.ident,
		displayName: app.displayName,
		repositoryPath: app.repositoryPath,
	};
	if (app.containerBaseName) cfg.containerBaseName = app.containerBaseName;
	if (app.sourceType) cfg.sourceType = app.sourceType;
	if (app.provider) cfg.provider = app.provider;
	if (app.gitMode) cfg.gitMode = app.gitMode;
	return cfg;
}

// ---- Project catalog projection ----

export const PROJECT_AVAILABLE = "available";
export const PROJECT_MISSING = "missing";
export const PROJECT_INVALID = "invalid";
export const PROJECT_UNRESOLVED = "unresolved";
export const PROJECT_KIND_APP = "app";
export const PROJECT_KIND_LIBRARY = "library";

export interface ProjectCapabilities {
	openspec: boolean;
}

export interface Project {
	ident: string;
	displayName: string;
	kind: string;
	canonicalRoot?: string;
	activeCheckout?: string;
	available: boolean;
	availability: string;
	detail?: string;
	capabilities: ProjectCapabilities;
}

export interface ProjectCatalog {
	revision: string;
	projects: Project[];
}

/** What the catalog may ask about the filesystem and Git. Bounded and
 * read-only by construction: there is no mutation operation. */
export interface CatalogObservation {
	/** `"directory"`, `"missing"` or `"not-directory"`. */
	pathKind(path: string): "directory" | "missing" | "not-directory";
	resolveCanonicalRoot(checkout: string): { root: string } | { error: string };
	openspecConfigured(root: string): boolean;
}

/**
 * Project the configured apps/libraries into the canonical catalog. A
 * duplicate configured ident is a catalog error, never a silent collapse; a
 * missing checkout keeps its configured identity and reports why.
 */
export function buildProjectCatalog(apps: readonly App[]): Project[] {
	const seen = new Set<string>();
	const projects: Project[] = [];
	for (const app of apps) {
		const ident = app.ident.trim();
		if (!ident) continue;
		if (seen.has(ident))
			throw new EnvironmentConfigError(
				`duplicate configured project ident ${JSON.stringify(ident)}`,
			);
		seen.add(ident);
		projects.push(projectFromApp(app));
	}
	projects.sort((left, right) => (left.ident < right.ident ? -1 : 1));
	return projects;
}

/** Projection without the availability probe: only the configured identity and
 * the selected checkout are known at this point. Optional fields are omitted
 * when empty and every project is built in the canonical field order, so the
 * serialized projection (and therefore its revision) matches the Go
 * `omitempty` payload. */
export function projectFromApp(app: App): Project {
	const project = {
		ident: app.ident,
		displayName: app.displayName,
		kind:
			app.appType === APP_TYPE_LIBRARY
				? PROJECT_KIND_LIBRARY
				: PROJECT_KIND_APP,
		...(app.localDirectoryPath
			? { activeCheckout: app.localDirectoryPath }
			: { detail: "no managed checkout path is known" }),
		available: false,
		availability: PROJECT_UNRESOLVED,
		capabilities: { openspec: false },
	} satisfies Project;
	return project;
}

/** Rebuild a project in the canonical field order after a probe. */
function withObservation(
	project: Project,
	observed: {
		canonicalRoot?: string;
		available: boolean;
		availability: string;
		detail?: string;
		capabilities: ProjectCapabilities;
	},
): Project {
	return {
		ident: project.ident,
		displayName: project.displayName,
		kind: project.kind,
		...(observed.canonicalRoot
			? { canonicalRoot: observed.canonicalRoot }
			: {}),
		...(project.activeCheckout
			? { activeCheckout: project.activeCheckout }
			: {}),
		available: observed.available,
		availability: observed.availability,
		...(observed.detail ? { detail: observed.detail } : {}),
		capabilities: observed.capabilities,
	} satisfies Project;
}

/**
 * Probe the projected catalog against the filesystem. Kept separate from
 * `projectFromApp` so a caller that only needs identity never touches disk.
 */
export function resolveProjectAvailability(
	project: Project,
	observation: CatalogObservation,
): Project {
	const checkout = project.activeCheckout;
	if (!checkout) return project;
	const kind = observation.pathKind(checkout);
	if (kind === "missing")
		return withObservation(project, {
			available: false,
			availability: PROJECT_MISSING,
			detail: "checkout is not cloned at the expected managed location",
			capabilities: { openspec: false },
		});
	if (kind === "not-directory")
		return withObservation(project, {
			available: false,
			availability: PROJECT_INVALID,
			detail: "checkout path exists but is not a directory",
			capabilities: { openspec: false },
		});
	const resolved = observation.resolveCanonicalRoot(checkout);
	if ("error" in resolved)
		return withObservation(project, {
			available: false,
			availability: PROJECT_INVALID,
			detail: resolved.error,
			capabilities: { openspec: observation.openspecConfigured(checkout) },
		});
	return withObservation(project, {
		canonicalRoot: resolved.root,
		available: true,
		availability: PROJECT_AVAILABLE,
		capabilities: {
			openspec:
				observation.openspecConfigured(resolved.root) ||
				observation.openspecConfigured(checkout),
		},
	});
}

/**
 * Canonical serialization of the projected catalog: every project is already
 * built in the Go field order with the same `omitempty` behavior, so a revision
 * computed by either runtime over the same projects is the same fingerprint.
 */
export function catalogPayload(projects: readonly Project[]): string {
	return JSON.stringify(projects);
}

/** Stable fingerprint of the projected catalog (16 hex chars, as in Go). */
export function catalogRevision(projects: readonly Project[]): string {
	const digest = new Bun.CryptoHasher("sha256")
		.update(catalogPayload(projects))
		.digest("hex");
	return digest.slice(0, 16);
}

export function newProjectCatalog(projects: Project[]): ProjectCatalog {
	return { revision: catalogRevision(projects), projects };
}

/** Branch name -> filesystem-safe directory segment (worktrunk's sanitize). */
export function worktreeBranchToDir(branch: string): string {
	return branch.replaceAll("/", "-").replaceAll("\\", "-");
}

/** `$DEVENV_HOME/{ident}/{ident}` — the primary worktree of an app. */
export function primaryWorktreePath(homeDir: string, ident: string): string {
	return `${homeDir}/${ident}/${ident}`;
}

/**
 * Absolute path of the currently active worktree with the disk-existence
 * fallback chain: primary when nothing is recorded or the primary is
 * explicitly selected, the linked worktree only while it exists, otherwise the
 * (possibly missing) primary so the caller reports "not cloned yet".
 *
 * The fallback deliberately does not short-circuit on an empty
 * `mainWorktreeBranch`: rows written before that column existed must still be
 * able to use their linked worktree.
 */
export function resolveActiveWorktreePath(
	homeDir: string,
	app: Pick<App, "ident" | "activeWorktree" | "mainWorktreeBranch">,
	exists: (path: string) => boolean,
): string {
	const appRoot = `${homeDir}/${app.ident}`;
	const primary = `${appRoot}/${app.ident}`;
	const active = app.activeWorktree ?? "";
	if (
		active === "" ||
		(app.mainWorktreeBranch && active === app.mainWorktreeBranch)
	)
		return primary;
	const linked = `${appRoot}/${app.ident}.${worktreeBranchToDir(active)}`;
	return exists(linked) ? linked : primary;
}
