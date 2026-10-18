// Seams: the only place that touches git, subprocess, time, network, and config I/O.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { configDiagnostic, resolveConfigRoot } from "../config-root.ts";
import type { WorkflowExecutionSettings } from "../contracts/workflow.ts";
import { loadEnvFile, resolveEnvReference } from "../env-file.ts";
import { TELEMETRY_FLUSH_BUDGET_MS } from "./observability.ts";

export function run(args: string[], cwd?: string): string {
	const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	if (result.exitCode !== 0) {
		const detail = (stderr || stdout || "command failed").trim();
		throw new Error(`${args.join(" ")}: ${detail}`);
	}
	return stdout.trim();
}

export class Git {
	/** Wraps git subprocess calls scoped to a working directory. */
	run(args: string[], cwd: string): string {
		return run(["git", ...args], cwd);
	}
}

export class Clock {
	now(): Date {
		return new Date();
	}

	monotonic(): number {
		return Bun.nanoseconds() / 1e9;
	}

	time(): number {
		return Date.now() / 1000;
	}

	timeNs(): bigint {
		return BigInt(Date.now()) * 1_000_000n;
	}

	async sleep(seconds: number): Promise<void> {
		await Bun.sleep(seconds * 1000);
	}
}

export interface JsonPostResult {
	readonly status: number;
	readonly body: string;
}

export interface JsonPostOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

/** Cancellable, bounded-lifetime JSON POST boundary for workflow providers. */
export function postJsonEffect(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	options: JsonPostOptions = {},
): Effect.Effect<JsonPostResult, Error> {
	return Effect.tryPromise({
		try: async () => {
			const controller = new AbortController();
			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, options.timeoutMs ?? 120_000);
			const abort = () => controller.abort();
			if (options.signal?.aborted) controller.abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			try {
				const response = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				return { status: response.status, body: await response.text() };
			} catch (error) {
				if (timedOut) throw new Error("request timed out");
				if (options.signal?.aborted) throw new Error("request canceled");
				throw error;
			} finally {
				clearTimeout(timeout);
				options.signal?.removeEventListener("abort", abort);
			}
		},
		catch: (error) =>
			error instanceof Error ? error : new Error(String(error)),
	});
}

function traceEndpoint(): string {
	const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
	if (tracesEndpoint) return tracesEndpoint;
	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	return endpoint
		? `${endpoint.replace(/\/$/, "")}/v1/traces`
		: "http://127.0.0.1:4318/v1/traces";
}

export interface SpanRecordLike {
	traceId: string;
	spanId: string;
	parentSpanId?: string | null;
	name: string;
	startTimeUnixNano: string | number;
	endTimeUnixNano: string | number;
	attributes: Record<string, unknown>;
	status?: string;
}

export interface Exporter {
	export(record: SpanRecordLike): void;
}

export class TraceExporter implements Exporter {
	/** Best-effort OTLP HTTP exporter; fire-and-forget, never raises. */
	export(record: SpanRecordLike): void {
		void this.send(record).catch(() => {});
	}

	private async send(record: SpanRecordLike): Promise<void> {
		const attributes = Object.entries(record.attributes).map(
			([key, value]) => ({ key, value: { stringValue: String(value) } }),
		);
		const payload = {
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: "herdr-workflow" } },
						],
					},
					scopeSpans: [
						{
							scope: { name: "herdr-workflow" },
							spans: [
								{
									traceId: record.traceId,
									spanId: record.spanId,
									parentSpanId: record.parentSpanId,
									name: record.name,
									startTimeUnixNano: record.startTimeUnixNano,
									endTimeUnixNano: record.endTimeUnixNano,
									attributes,
									status: { code: record.status === "ERROR" ? 2 : 1 },
								},
							],
						},
					],
				},
			],
		};
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			TELEMETRY_FLUSH_BUDGET_MS,
		);
		try {
			await fetch(traceEndpoint(), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}
	}
}

/** Canonical global workflow configuration file under the resolved root. */
export const WORKFLOW_CONFIG_FILE = "config.json";
/** Repository overlay. JSON is the only configuration form. */
export const PROJECT_OVERLAY_FILE = "herdr-workflow.json";

/**
 * Parse a configuration document. Only the current JSON format is read: any
 * other file is refused by name rather than interpreted, so an obsolete source
 * is never merged and never rewritten.
 */
export function parseConfigDocument(
	file: string,
	raw: string,
): Record<string, unknown> {
	if (!file.endsWith(".json"))
		throw new Error(
			`failed to parse config ${file}: only the current JSON configuration format is supported`,
		);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`failed to parse config ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`failed to parse config ${file}: expected a JSON object`);
	return parsed as Record<string, unknown>;
}

/** Read a configuration document without changing cwd. A missing file is empty,
 * an unparseable file throws. */
export function readConfigDocument(file: string): Record<string, unknown> {
	if (!fs.existsSync(file)) return {};
	return parseConfigDocument(file, fs.readFileSync(file, "utf8"));
}

export function deepMergeConfig<T extends object>(
	base: T,
	overlay: unknown,
): T {
	return deepMerge(base, overlay);
}

export function deepMerge<T extends object>(base: T, overlay: unknown): T {
	const merged = structuredClone(base) as Record<string, unknown>;
	if (!overlay || typeof overlay !== "object" || Array.isArray(overlay))
		return merged as T;
	for (const [key, value] of Object.entries(overlay)) {
		// A literal "__proto__" key in a configuration file would otherwise
		// replace the merged object's prototype with attacker-controlled data.
		if (key === "__proto__" || key === "constructor" || key === "prototype")
			continue;
		if (
			merged[key] &&
			typeof merged[key] === "object" &&
			!Array.isArray(merged[key]) &&
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value)
		) {
			merged[key] = deepMerge(merged[key] as Record<string, unknown>, value);
		} else merged[key] = value;
	}
	return merged as T;
}

export interface WorkflowConfig {
	agents?: unknown;
	workflow: {
		max_verification_rounds: number;
		remote: string;
		branch_prefix: string;
		base_branch: string;
		pr_tool?: string;
	};
	telemetry: {
		capture_content: boolean;
		/**
		 * Receiver listeners (`telemetry.receiver.*`, `add-agent-debug-tools`).
		 * File-only, like the app-run lifecycle settings: the process that binds
		 * the receivers reads them, and no Settings row edits them.
		 */
		receiver?: {
			/** Addresses beyond loopback the telemetry receivers bind: `auto` (the
			 * container bridge gateway, on a Linux engine), `off` (loopback only),
			 * or one explicit address. A wildcard address is never bound. */
			container_bind?: string;
		};
	};
	ui: {
		theme: string;
		selection_height: number;
		/** Which side the workspace sidebar is mounted on; the shell resolves it
		 * once and panel movement follows it. */
		sidebar_side?: "left" | "right";
		/** How the workspace sidebar sizes itself: `expanding` (the default)
		 * collapses it to each workspace's status glyph and index while unfocused
		 * and expands it on focus; `permanent` keeps it expanded. The shell can
		 * toggle the mode at runtime; this is only its initial value. */
		sidebar_mode?: "expanding" | "permanent";
	};
	wiki?: { root?: string; reviewer?: string };
	/**
	 * App-run lifecycle settings (`environment.instances.*`). File-only for now:
	 * the value is read by the server that owns the slots, and no Settings row
	 * edits it.
	 */
	environment?: {
		instances?: {
			/** Minutes an agent-held app may sit idle before it is released. */
			idle_ttl_minutes?: number;
			/**
			 * Seconds a run may take to reach the readiness its definition declares
			 * (a compose healthcheck, a published port, a `devenv:ready=` endpoint)
			 * before the start answers `starting` instead of `running`
			 * (`fix-env-tools-round-2`). Defaults to 120.
			 */
			readiness_timeout_seconds?: number;
			/**
			 * Seconds a run target that declares no readiness of its own must stay up
			 * before its start counts as a start. Defaults to 2 (the settle window
			 * `RUN_SETTLE_MS` the shell start always had).
			 */
			run_settle_seconds?: number;
		};
	};
	/**
	 * Browser sessions an agent drives (`browser.*`, `add-agent-browser-sessions`).
	 * File-only, like the app-run lifecycle settings: the server that owns the
	 * browser pool reads them, and Settings shows the effective values.
	 */
	browser?: {
		/** Browser sessions the one shared Chromium keeps open at once. */
		max_sessions?: number;
		/** Minutes a browser session may sit idle before it is closed. */
		idle_ttl_minutes?: number;
		/** The viewport a new session opens with. */
		viewport?: { width?: number; height?: number };
	};
}

/** Built-in fallback (mirror of pi/herdr-workflow.json) — used only when no
 * config file exists anywhere. Models are intentionally NOT defaulted: an
 * unconfigured step lets pi pick its own default model.
 *
 * `wiki.root` is intentionally absent: its default is not a fixed path but a
 * function of the configuration root (`defaultWikiRoot()` in `./wiki.ts`), so
 * writing it down here would pin every configuration — a relocated one
 * included — to the developer's `~/.config/agentic-coding/wiki`. A configured
 * `wiki.root` still wins, and resolves to the same path when the configuration
 * root is the default one. */
export const DEFAULT_CONFIG: WorkflowConfig = {
	workflow: {
		max_verification_rounds: 6,
		remote: "origin",
		branch_prefix: "feature/",
		base_branch: "origin/HEAD",
	},
	telemetry: { capture_content: true, receiver: { container_bind: "auto" } },
	ui: {
		theme: "catppuccin",
		selection_height: 10,
	},
	environment: { instances: { idle_ttl_minutes: 30 } },
	browser: {
		max_sessions: 4,
		idle_ttl_minutes: 15,
		viewport: { width: 1280, height: 800 },
	},
};

export interface ConfigProvenance {
	source: "default" | "environment" | "user" | "project";
	files: readonly string[];
	repository?: string;
}

export interface ResolvedWorkflowConfig {
	config: WorkflowConfig;
	provenance: ConfigProvenance;
}

export function settingsFingerprint(
	settings: WorkflowExecutionSettings,
): string {
	return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

export function executionSettings(
	config: WorkflowConfig,
	provenance: ConfigProvenance,
): WorkflowExecutionSettings {
	const configured = config.workflow.pr_tool;
	return {
		remote: config.workflow.remote,
		prTool: configured
			? (Bun.which(configured) ?? null)
			: (Bun.which("gh") ?? Bun.which("glab") ?? null),
		provenance: {
			source: provenance.source,
			files: [...provenance.files],
		},
	};
}

/** git common-dir lookups are stable for a repository and are re-run on every
 * config read; the dashboard editor reads config many times per render, so the
 * resolved root is cached per repository to avoid spawning `git rev-parse`
 * repeatedly. Only successful lookups are cached so a repository created after
 * the first miss is still picked up. */
const repositoryRootCache = new Map<string, string>();
function repositoryConfigRoot(repository: string): string | undefined {
	const resolvedPath = path.resolve(repository);
	const cached = repositoryRootCache.get(resolvedPath);
	if (cached) return cached;
	try {
		const result = Bun.spawnSync(
			["git", "-C", resolvedPath, "rev-parse", "--git-common-dir"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		if (result.exitCode !== 0) return undefined;
		const common = result.stdout.toString().trim();
		if (!common) return undefined;
		const absolute = path.resolve(resolvedPath, common);
		const root =
			path.basename(absolute) === ".git" ? path.dirname(absolute) : absolute;
		repositoryRootCache.set(resolvedPath, root);
		return root;
	} catch {
		return undefined;
	}
}

/** Resolve config without changing cwd. `repository` is the only source of a
 * project overlay. */
export type ConfigOptions =
	| string
	| { repository?: string; repositoryIndependent?: boolean };

export function loadConfigWithProvenance(
	options: ConfigOptions = {},
): ResolvedWorkflowConfig {
	try {
		return resolveConfigWithProvenance(options);
	} catch (error) {
		// A configuration load that throws is an error, not a compatibility
		// notice: report it to the same sink and let it keep propagating, so the
		// surface can show a blocking dialog and the caller's error contract is
		// unchanged.
		configDiagnostic(
			error instanceof Error ? error.message : String(error),
			"error",
		);
		throw error;
	}
}

function resolveConfigWithProvenance(
	options: ConfigOptions = {},
): ResolvedWorkflowConfig {
	const normalized =
		typeof options === "string" ? { repository: options } : options;
	const envPath = process.env.HERDR_WORKFLOW_CONFIG;
	if (envPath) {
		const environmentConfig = deepMerge(
			structuredClone(DEFAULT_CONFIG),
			readConfigDocument(envPath),
		);
		return {
			config: environmentConfig,
			provenance: { source: "environment", files: [envPath] },
		};
	}
	const configRoot = resolveConfigRoot();
	const canonical = path.join(configRoot, WORKFLOW_CONFIG_FILE);
	// The canonical JSON file is the only global workflow configuration source:
	// an obsolete file is neither read nor reported as a shadowed second
	// authority.
	const file = fs.existsSync(canonical) ? canonical : undefined;
	let cfg = deepMerge(
		structuredClone(DEFAULT_CONFIG),
		file ? readConfigDocument(file) : {},
	);
	const projectRoot = normalized.repositoryIndependent
		? undefined
		: (repositoryConfigRoot(normalized.repository ?? process.cwd()) ??
			(normalized.repository
				? path.resolve(normalized.repository)
				: process.cwd()));
	const projectConfig = projectRoot
		? path.join(projectRoot, ".pi", PROJECT_OVERLAY_FILE)
		: undefined;
	if (projectConfig && fs.existsSync(projectConfig))
		cfg = deepMerge(cfg, readConfigDocument(projectConfig));
	const baseSource: ConfigProvenance["source"] = file ? "user" : "default";
	return {
		config: cfg,
		provenance: {
			source:
				projectConfig && fs.existsSync(projectConfig) ? "project" : baseSource,
			files: [
				...(file ? [file] : []),
				...(projectConfig && fs.existsSync(projectConfig)
					? [projectConfig]
					: []),
			],
			...(projectRoot ? { repository: projectRoot } : {}),
		},
	};
}

export function loadConfig(options?: ConfigOptions): WorkflowConfig {
	return loadConfigWithProvenance(options).config;
}

/** The built-in receiver bind mode: the bridge gateway, on a Linux engine. */
export const DEFAULT_RECEIVER_CONTAINER_BIND = "auto";

/**
 * How the telemetry receivers bind beyond loopback, from the layered
 * configuration's `telemetry.receiver.container_bind`. `auto` (the default)
 * binds the container bridge gateway when a Linux engine is detected, `off`
 * keeps them loopback-only, and anything else is an explicit address. An empty
 * or missing value falls back to `auto`; a wildcard address is never bound
 * (`src/server/receivers/bind.ts` refuses it).
 */
export function receiverContainerBind(
	config: WorkflowConfig = loadConfig(),
): string {
	const value = config.telemetry?.receiver?.container_bind;
	if (typeof value !== "string") return DEFAULT_RECEIVER_CONTAINER_BIND;
	const trimmed = value.trim();
	return trimmed === "" ? DEFAULT_RECEIVER_CONTAINER_BIND : trimmed;
}

/** Built-in idle TTL for an agent-held app: 30 minutes. */
export const DEFAULT_ENVIRONMENT_IDLE_TTL_MS = 30 * 60 * 1000;

/** Built-in readiness bound of one start: two minutes. Long enough for a
 * container whose application serves in tens of seconds, bounded so a start can
 * never hang the tool call. */
export const DEFAULT_ENVIRONMENT_READINESS_MS = 120 * 1000;
/** The settle window a run target with no declared readiness must survive; the
 * value the slot controller always had. */
export const DEFAULT_RUN_SETTLE_MS = 2 * 1000;
/** Hard ceiling of either bound, whatever the configuration says (an hour). */
export const MAX_ENVIRONMENT_READINESS_SECONDS = 3600;

/** Built-in browser session bounds (`browser.*`). */
export const DEFAULT_BROWSER_MAX_SESSIONS = 4;
export const DEFAULT_BROWSER_IDLE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_BROWSER_VIEWPORT = { width: 1280, height: 800 } as const;
/** The widest screenshot returned to a model, in CSS pixels. */
export const BROWSER_MAX_IMAGE_WIDTH = 1280;
/** The smallest and largest viewport a session may be opened with. */
export const BROWSER_MIN_VIEWPORT = 200;
export const BROWSER_MAX_VIEWPORT = 4096;

export interface ResolvedBrowserSettings {
	readonly maxSessions: number;
	readonly idleTtlMs: number;
	readonly viewport: { readonly width: number; readonly height: number };
}

function boundedViewportSide(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(
		BROWSER_MAX_VIEWPORT,
		Math.max(BROWSER_MIN_VIEWPORT, Math.round(value)),
	);
}

/**
 * The effective browser bounds, from the layered configuration's `browser.*`.
 * Every unusable value falls back to the built-in default: a typo must never
 * disable the idle lifecycle that keeps the session cap moving, nor open a
 * session at a viewport no model could read.
 */
export function resolvedBrowserSettings(
	config: WorkflowConfig = loadConfig(),
): ResolvedBrowserSettings {
	const sessions = config.browser?.max_sessions;
	const minutes = config.browser?.idle_ttl_minutes;
	const viewport = config.browser?.viewport;
	return {
		maxSessions:
			typeof sessions === "number" && Number.isFinite(sessions) && sessions >= 1
				? Math.floor(sessions)
				: DEFAULT_BROWSER_MAX_SESSIONS,
		idleTtlMs:
			typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
				? minutes * 60_000
				: DEFAULT_BROWSER_IDLE_TTL_MS,
		viewport: {
			width: boundedViewportSide(
				viewport?.width,
				DEFAULT_BROWSER_VIEWPORT.width,
			),
			height: boundedViewportSide(
				viewport?.height,
				DEFAULT_BROWSER_VIEWPORT.height,
			),
		},
	};
}

/**
 * How long a run may take to reach the readiness its definition declares, from
 * the layered configuration's `environment.instances.readiness_timeout_seconds`
 * (`fix-env-tools-round-2`). A missing or unusable value falls back to two
 * minutes: a start that waits too long is a slow tool call, a start that does
 * not wait at all reports a run as running while the application serves
 * nothing.
 */
export function environmentInstanceReadinessMs(
	config: WorkflowConfig = loadConfig(),
): number {
	const seconds = config.environment?.instances?.readiness_timeout_seconds;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
		return DEFAULT_ENVIRONMENT_READINESS_MS;
	return Math.min(seconds, MAX_ENVIRONMENT_READINESS_SECONDS) * 1_000;
}

/** How long a run target with no declared readiness must stay up, from the
 * layered configuration's `environment.instances.run_settle_seconds`. */
export function environmentInstanceRunSettleMs(
	config: WorkflowConfig = loadConfig(),
): number {
	const seconds = config.environment?.instances?.run_settle_seconds;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
		return DEFAULT_RUN_SETTLE_MS;
	return Math.min(seconds, MAX_ENVIRONMENT_READINESS_SECONDS) * 1_000;
}

/**
 * How long an agent-held app may sit idle before the server's reaper stops it,
 * from the layered configuration's `environment.instances.idle_ttl_minutes`.
 * Resolved per reap pass, so an edit applies to the next pass. A missing or
 * unusable value falls back to the 30-minute default: a typo must never disable
 * the lifecycle that keeps the queue moving.
 */
export function environmentInstanceIdleTtlMs(
	config: WorkflowConfig = loadConfig(),
): number {
	const minutes = config.environment?.instances?.idle_ttl_minutes;
	if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0)
		return DEFAULT_ENVIRONMENT_IDLE_TTL_MS;
	return minutes * 60_000;
}
/** Resolve one secret from process environment or selected config-root `.env`.
 * Explicit process values win, matching provider credential resolution. */
export function configEnvValue(name: string): string | undefined {
	return resolveEnvReference(name, {
		fileVars: loadEnvFile(path.join(resolveConfigRoot(), ".env")),
	});
}

/** The trusted user-owned configuration file, in load precedence order under
 * the resolved root. Project overlays and `HERDR_WORKFLOW_CONFIG` are
 * deliberately excluded: the sidebar preference is server-wide in effect, so a
 * repository must not be able to flip it. `root`/`home` stay injectable so the
 * precedence is testable without touching the process environment. */
export function userConfigPaths(
	_home = os.homedir(),
	root: string = resolveConfigRoot(),
): string[] {
	return [path.join(root, WORKFLOW_CONFIG_FILE)];
}

/** Resolve the config file that dashboard edits write back to (see
 * selectAgentsConfigPath for the precedence rules). */
export function agentsConfigPath(
	repository?: string,
	options: { userScope?: boolean } = {},
): string {
	const cwd = repository
		? (repositoryConfigRoot(repository) ?? path.resolve(repository))
		: process.cwd();
	return selectAgentsConfigPath(
		process.env.HERDR_WORKFLOW_CONFIG,
		cwd,
		resolveConfigRoot(),
		options,
	);
}
/** Resolve the write-back target for dashboard edits. The target must be the
 * file that wins at load precedence for the agents section, otherwise edits
 * are silently shadowed at load time:
 * 1. HERDR_WORKFLOW_CONFIG replaces the whole config (loadConfig skips the
 *    project overlay for it), so it always wins.
 * 2. The base file is the canonical `config.json` under the resolved root.
 * 3. A project overlay supplying [agents] deep-merges over that base, so it is
 *    the target whenever it exists with an agents section.
 * 4. Otherwise the base file is the target (created if none exists). */
export function selectAgentsConfigPath(
	envPath: string | undefined,
	cwd: string,
	root: string = resolveConfigRoot(),
	options: { userScope?: boolean } = {},
): string {
	if (envPath) return envPath;
	const baseCandidates = [path.join(root, WORKFLOW_CONFIG_FILE)];
	// A user-scope write (the compaction policy) is pinned to the user-level
	// files: a project overlay must not be able to capture an edit that the
	// durable host reads from the user document.
	if (options.userScope) return baseCandidates[0];
	const projectJson = path.join(cwd, ".pi", PROJECT_OVERLAY_FILE);
	if (fs.existsSync(projectJson) && "agents" in readConfigDocument(projectJson))
		return projectJson;
	const base = baseCandidates.find((candidate) => fs.existsSync(candidate));
	return base ?? baseCandidates[0];
}
/** Existing base config files that also supply an [agents] section while the
 * write-back target is the project overlay. Only this combination conflicts:
 * loadConfig deep-merges base into project, so entries living only in the base
 * cannot be removed via the target and resurrect at load time. With
 * HERDR_WORKFLOW_CONFIG set (full replacement) there is never a conflict. */
export function conflictingAgentsFiles(
	_home: string = os.homedir(),
	cwd: string = process.cwd(),
	root: string = resolveConfigRoot(),
): string[] {
	const target = selectAgentsConfigPath(undefined, cwd, root);
	const projectOverlays = [path.join(cwd, ".pi", PROJECT_OVERLAY_FILE)];
	if (!projectOverlays.includes(target)) return [];
	return [path.join(root, WORKFLOW_CONFIG_FILE)].filter(
		(candidate) =>
			fs.existsSync(candidate) && "agents" in readConfigDocument(candidate),
	);
}
/** Atomically write one config document as JSON. Rename a temporary file so a
 * failed serialization or write cannot leave a truncated config; resolve
 * symlinks before renaming so the operator keeps the link itself intact. A
 * target that is not a JSON document is refused before anything is created, so
 * an explicit replacement naming an obsolete file can never be materialized in
 * a format the reader then rejects. */
function writeConfigDocument(
	file: string,
	document: Record<string, unknown>,
): void {
	if (!file.endsWith(".json"))
		throw new Error(
			`${file} is not the current JSON configuration format; refusing to write it`,
		);
	const contents = `${JSON.stringify(document, null, 2)}\n`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const target =
		fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()
			? fs.realpathSync(file)
			: file;
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.writeFileSync(temporary, contents, { mode: 0o600 });
		fs.renameSync(temporary, target);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

/** The config file a global `ui.*` edit writes back to: the explicit
 * replacement file, else the canonical JSON config — never a project overlay,
 * because a project-scoped UI preference would shadow the user's own choice at
 * load time. */
export function selectUiConfigPath(
	envPath: string | undefined,
	_home: string,
	root: string = resolveConfigRoot(),
): string {
	return envPath ?? path.join(root, WORKFLOW_CONFIG_FILE);
}

/** Persist `ui.sidebar_mode` so a sidebar toggle survives restarts. Read-
 * modify-write with unknown keys preserved. */
export function saveSidebarMode(
	mode: "expanding" | "permanent",
	options: { home?: string; root?: string } = {},
): void {
	const file = selectUiConfigPath(
		process.env.HERDR_WORKFLOW_CONFIG,
		options.home ?? os.homedir(),
		options.root,
	);
	const document = readConfigDocument(file);
	const ui =
		document.ui &&
		typeof document.ui === "object" &&
		!Array.isArray(document.ui)
			? (document.ui as Record<string, unknown>)
			: {};
	ui.sidebar_mode = mode;
	document.ui = ui;
	writeConfigDocument(file, document);
}

/** Read-modify-write the JSON config file backing the agents section. Unknown
 * keys are preserved as read; JSON has no comments to lose. */
export function saveAgentsSection(
	mutate: (agents: Record<string, unknown>) => void,
	repository?: string,
	options: { userScope?: boolean } = {},
): void {
	const cwd = repository
		? (repositoryConfigRoot(repository) ?? path.resolve(repository))
		: process.cwd();
	// A user-scope write targets a base file by construction, so no project
	// overlay can shadow it and the conflicting-definition guard does not apply.
	const conflicts = options.userScope
		? []
		: conflictingAgentsFiles(os.homedir(), cwd);
	if (conflicts.length)
		throw new Error(
			`[agents] is also defined in ${conflicts.join(", ")}; edit the layered sources separately`,
		);
	const file = agentsConfigPath(repository, options);
	const document = readConfigDocument(file);
	if (
		!document.agents ||
		typeof document.agents !== "object" ||
		Array.isArray(document.agents)
	)
		document.agents = {};
	mutate(document.agents as Record<string, unknown>);
	writeConfigDocument(file, document);
}

export interface Context {
	config: WorkflowConfig;
	git: Git;
	clock: Clock;
	exporter: Exporter;
}
