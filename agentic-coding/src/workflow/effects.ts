// Seams: the only place that touches git, subprocess, time, network, and config I/O.
// Herdr access itself lives in ../herdr-client.ts (the single shared `.result` parser).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import {
	assertNoPendingMigration,
	configDiagnostic,
	resolveConfigRoot,
} from "../config-root.ts";
import type { WorkflowExecutionSettings } from "../contracts/workflow.ts";
import { loadEnvFile, resolveEnvReference } from "../env-file.ts";
import { Herdr } from "../herdr-client.ts";
import { TELEMETRY_FLUSH_BUDGET_MS } from "./observability.ts";

export { Herdr };

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
/** Repository overlay. JSON is the only writable form. */
export const PROJECT_OVERLAY_FILE = "herdr-workflow.json";
/** Read-only repository overlay compatibility input; edits need conversion. */
export const LEGACY_PROJECT_OVERLAY_FILE = "herdr-workflow.toml";
/** Legacy user-level workflow configuration basename under `~/.pi/agent`. */
export const LEGACY_USER_CONFIG_FILE = "herdr-workflow.toml";
/** Pre-migration canonical file name; inactive once `config.json` exists. */
export const LEGACY_WORKFLOW_CONFIG_FILE = "config.toml";

function configFormat(file: string): "json" | "toml" {
	return file.endsWith(".json") ? "json" : "toml";
}

/**
 * Parse a configuration document by extension. JSON is strict and must be an
 * object; TOML is a read-only compatibility input. The error names the file so
 * a broken configuration is attributable.
 */
export function parseConfigDocument(
	file: string,
	raw: string,
): Record<string, unknown> {
	if (configFormat(file) === "json") {
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
	return Bun.TOML.parse(raw) as Record<string, unknown>;
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
	/** Legacy-only input migrated by profile parser. */
	models?: Record<string, string>;
	thinking?: Record<string, string>;
	agents?: unknown;
	workflow: {
		max_verification_rounds: number;
		remote: string;
		branch_prefix: string;
		base_branch: string;
		pr_tool?: string;
	};
	telemetry: { capture_content: boolean };
	ui: {
		theme: string;
		selection_height: number;
		/** Trusted user-only opt-in for the native Herdr sidebar integration
		 * (improve-herdr-workflow-sidebar); project overlays cannot change it. */
		herdr_sidebar?: boolean;
	};
	wiki?: { root?: string; reviewer?: string };
}

/** Built-in fallback (mirror of pi/herdr-workflow.toml) — used only when no
 * config file exists anywhere. Models are intentionally NOT defaulted: an
 * unconfigured step lets pi pick its own default model. */
export const DEFAULT_CONFIG: WorkflowConfig = {
	workflow: {
		max_verification_rounds: 6,
		remote: "origin",
		branch_prefix: "feature/",
		base_branch: "origin/HEAD",
	},
	telemetry: { capture_content: true },
	ui: { theme: "catppuccin", selection_height: 10, herdr_sidebar: false },
	wiki: { root: "~/.config/agentic-coding/wiki" },
};

export interface ConfigProvenance {
	source: "default" | "environment" | "user" | "legacy" | "project";
	files: readonly string[];
	/** Legacy sources left in place but not read because a higher-precedence
	 * format is active. Reported, never merged (Settings migration state). */
	inactiveFiles?: readonly string[];
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
 * project overlay; omit it for the caller's legacy cwd-compatible behavior. */
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
		return {
			config: deepMerge(
				structuredClone(DEFAULT_CONFIG),
				readConfigDocument(envPath),
			),
			provenance: { source: "environment", files: [envPath] },
		};
	}
	const configRoot = resolveConfigRoot();
	// An interrupted migration leaves a known partial snapshot on disk; refuse it
	// rather than read a mixed state.
	assertNoPendingMigration(configRoot);
	const canonical = path.join(configRoot, WORKFLOW_CONFIG_FILE);
	const legacyCanonical = path.join(configRoot, LEGACY_WORKFLOW_CONFIG_FILE);
	const legacyUser = path.join(
		os.homedir(),
		".pi",
		"agent",
		LEGACY_USER_CONFIG_FILE,
	);
	// JSON wins at the root scope. A leftover pre-migration `config.toml` is an
	// inactive source to report, never a second authority to merge.
	const file = [canonical, legacyCanonical, legacyUser].find((candidate) =>
		fs.existsSync(candidate),
	);
	const inactiveFiles: string[] = [];
	if (fs.existsSync(canonical) && fs.existsSync(legacyCanonical)) {
		inactiveFiles.push(legacyCanonical);
		configDiagnostic(
			`${legacyCanonical} is inactive: ${WORKFLOW_CONFIG_FILE} is the active workflow configuration`,
		);
	}
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
	const projectJson = projectRoot
		? path.join(projectRoot, ".pi", PROJECT_OVERLAY_FILE)
		: undefined;
	const projectToml = projectRoot
		? path.join(projectRoot, ".pi", LEGACY_PROJECT_OVERLAY_FILE)
		: undefined;
	// Two formats at one repository scope would make the effective configuration
	// depend on an implicit merge order, so it is refused instead of guessed.
	if (
		projectJson &&
		projectToml &&
		fs.existsSync(projectJson) &&
		fs.existsSync(projectToml)
	)
		throw new Error(
			`${projectRoot} supplies both ${PROJECT_OVERLAY_FILE} and ${LEGACY_PROJECT_OVERLAY_FILE}; keep one format (convert the TOML overlay explicitly) rather than relying on an implicit merge`,
		);
	const projectConfig =
		projectJson && fs.existsSync(projectJson)
			? projectJson
			: projectToml && fs.existsSync(projectToml)
				? projectToml
				: undefined;
	if (projectConfig) {
		if (configFormat(projectConfig) === "toml")
			configDiagnostic(
				`${projectConfig} is a legacy TOML overlay; it is read for compatibility but edits require an explicit conversion to ${PROJECT_OVERLAY_FILE}`,
			);
		cfg = deepMerge(cfg, readConfigDocument(projectConfig));
	}
	const baseSource: ConfigProvenance["source"] = file
		? file === canonical
			? "user"
			: "legacy"
		: "default";
	return {
		config: cfg,
		provenance: {
			source: projectConfig ? "project" : baseSource,
			files: [
				...(file ? [file] : []),
				...(projectConfig ? [projectConfig] : []),
			],
			...(inactiveFiles.length ? { inactiveFiles } : {}),
			...(projectRoot ? { repository: projectRoot } : {}),
		},
	};
}

export function loadConfig(options?: ConfigOptions): WorkflowConfig {
	return loadConfigWithProvenance(options).config;
}

/** Resolve one secret from process environment or selected config-root `.env`.
 * Explicit process values win, matching provider credential resolution. */
export function configEnvValue(name: string): string | undefined {
	return resolveEnvReference(name, {
		fileVars: loadEnvFile(path.join(resolveConfigRoot(), ".env")),
	});
}

/** The trusted user-owned configuration files, in load precedence order
 * (canonical user config under the resolved root, then the legacy path).
 * Project overlays and `HERDR_WORKFLOW_CONFIG` are deliberately excluded: the
 * sidebar preference is server-wide in effect, so a repository must not be
 * able to flip it. `root`/`home` stay injectable so the precedence is testable
 * without touching the process environment. */
export function userConfigPaths(
	home = os.homedir(),
	root: string = resolveConfigRoot(),
): string[] {
	return [
		path.join(root, WORKFLOW_CONFIG_FILE),
		path.join(root, LEGACY_WORKFLOW_CONFIG_FILE),
		path.join(home, ".pi", "agent", LEGACY_USER_CONFIG_FILE),
	];
}

/** `ui.herdr_sidebar`, default false (improve-herdr-workflow-sidebar). The
 * canonical root is an independent input from `home` (the legacy `~/.pi` path
 * lives outside it), so both are injected rather than derived from one another. */
export function herdrSidebarEnabled(
	home = os.homedir(),
	root: string = resolveConfigRoot(),
): boolean {
	for (const candidate of userConfigPaths(home, root)) {
		try {
			if (!fs.existsSync(candidate)) continue;
			const parsed = readConfigDocument(candidate) as {
				ui?: { herdr_sidebar?: unknown };
			};
			return parsed.ui?.herdr_sidebar === true;
		} catch {
			return false;
		}
	}
	return false;
}

/** Resolve the config file that dashboard edits write back to (see
 * selectAgentsConfigPath for the precedence rules). */
export function agentsConfigPath(repository?: string): string {
	const cwd = repository
		? (repositoryConfigRoot(repository) ?? path.resolve(repository))
		: process.cwd();
	return selectAgentsConfigPath(
		process.env.HERDR_WORKFLOW_CONFIG,
		os.homedir(),
		cwd,
	);
}
/** Resolve the write-back target for dashboard edits. The target must be the
 * file that wins at load precedence for the agents section, otherwise edits
 * are silently shadowed at load time:
 * 1. HERDR_WORKFLOW_CONFIG replaces the whole config (loadConfig skips the
 *    project overlay for it), so it always wins.
 * 2. The winning base file is the FIRST EXISTING of canonical `config.json` >
 *    legacy `config.toml` > legacy `~/.pi/agent/herdr-workflow.toml` —
 *    mirroring loadConfig's candidates.find; lower-priority base files are
 *    never read when a higher one exists.
 * 3. A project overlay supplying [agents] deep-merges over that base, so it is
 *    the target whenever it exists with an agents section.
 * 4. Otherwise the winning base file is the target (created if none exists),
 *    preferring the canonical JSON config path.
 * A resolved `.toml` target is a read-only compatibility input: every caller
 * writes JSON only, and saveAgentsSection refuses a TOML target so a legacy
 * file can never be silently rewritten or shadowed. */
export function selectAgentsConfigPath(
	envPath: string | undefined,
	home: string,
	cwd: string,
	root: string = resolveConfigRoot(),
): string {
	if (envPath) return envPath;
	const baseCandidates = [
		path.join(root, WORKFLOW_CONFIG_FILE),
		path.join(root, LEGACY_WORKFLOW_CONFIG_FILE),
		path.join(home, ".pi", "agent", LEGACY_USER_CONFIG_FILE),
	];
	const projectJson = path.join(cwd, ".pi", PROJECT_OVERLAY_FILE);
	const projectToml = path.join(cwd, ".pi", LEGACY_PROJECT_OVERLAY_FILE);
	if (fs.existsSync(projectJson) && "agents" in readConfigDocument(projectJson))
		return projectJson;
	if (fs.existsSync(projectToml) && "agents" in readConfigDocument(projectToml))
		return projectToml;
	const base = baseCandidates.find((candidate) => fs.existsSync(candidate));
	if (base) return base;
	if (fs.existsSync(projectJson)) return projectJson;
	if (fs.existsSync(projectToml)) return projectToml;
	return baseCandidates[0];
}
/** Existing base config files that also supply an [agents] section while the
 * write-back target is the project overlay. Only this combination conflicts:
 * loadConfig deep-merges base into project, so entries living only in the base
 * cannot be removed via the target and resurrect at load time. With
 * HERDR_WORKFLOW_CONFIG set (full replacement) there is never a conflict. */
export function conflictingAgentsFiles(
	home: string = os.homedir(),
	cwd: string = process.cwd(),
	root: string = resolveConfigRoot(),
): string[] {
	const target = selectAgentsConfigPath(undefined, home, cwd, root);
	const projectOverlays = [
		path.join(cwd, ".pi", PROJECT_OVERLAY_FILE),
		path.join(cwd, ".pi", LEGACY_PROJECT_OVERLAY_FILE),
	];
	if (!projectOverlays.includes(target)) return [];
	return [
		path.join(root, WORKFLOW_CONFIG_FILE),
		path.join(root, LEGACY_WORKFLOW_CONFIG_FILE),
		path.join(home, ".pi", "agent", LEGACY_USER_CONFIG_FILE),
	].filter(
		(candidate) =>
			fs.existsSync(candidate) && "agents" in readConfigDocument(candidate),
	);
}
/** Read-modify-write the JSON config file backing the agents section. Unknown
 * keys are preserved as read; JSON has no comments to lose. A legacy TOML
 * target is refused rather than converted silently, so an existing user file is
 * never rewritten in a different format behind the operator's back. */
export function saveAgentsSection(
	mutate: (agents: Record<string, unknown>) => void,
	repository?: string,
): void {
	const cwd = repository
		? (repositoryConfigRoot(repository) ?? path.resolve(repository))
		: process.cwd();
	const conflicts = conflictingAgentsFiles(os.homedir(), cwd);
	if (conflicts.length)
		throw new Error(
			`[agents] is also defined in ${conflicts.join(", ")}; edit the layered sources separately`,
		);
	const file = agentsConfigPath(repository);
	if (configFormat(file) === "toml")
		throw new Error(
			`${file} is a legacy TOML configuration read for compatibility; run \`agentic-coding config migrate\` (or convert the file explicitly) before editing it`,
		);
	const document = readConfigDocument(file);
	if (
		!document.agents ||
		typeof document.agents !== "object" ||
		Array.isArray(document.agents)
	)
		document.agents = {};
	mutate(document.agents as Record<string, unknown>);
	const contents = `${JSON.stringify(document, null, 2)}\n`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// Rename a temporary file so a failed serialization or write cannot leave a
	// truncated config. Resolve symlinks before renaming so the dashboard keeps
	// the link itself intact on Linux.
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

export interface Context {
	config: WorkflowConfig;
	herdr: Herdr;
	git: Git;
	clock: Clock;
	exporter: Exporter;
}
