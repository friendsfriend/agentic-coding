// Seams: the only place that touches git, subprocess, time, network, and config I/O.
// Herdr access itself lives in ../herdr-client.ts (the single shared `.result` parser).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Herdr } from "../herdr-client.ts";
import type { WorkflowExecutionSettings } from "./contracts.ts";

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
		const timeout = setTimeout(() => controller.abort(), 750);
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

function tomlKey(key: string): string {
	return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}
function tomlValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) {
		if (value.every((item) => !item || typeof item !== "object"))
			return `[${value.map(tomlValue).join(", ")}]`;
		return JSON.stringify(value);
	}
	if (value && typeof value === "object")
		return `{ ${Object.entries(value)
			.map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`)
			.join(", ")} }`;
	throw new Error(`unsupported TOML value: ${String(value)}`);
}
function stringifyToml(document: Record<string, unknown>): string {
	const lines: string[] = [];
	const isTable = (value: unknown): value is Record<string, unknown> =>
		Boolean(
			value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				!(value instanceof Date),
		);
	const writeTable = (table: Record<string, unknown>, prefix: string) => {
		const entries = Object.entries(table);
		// TOML keeps current table scope after a child table header. Emit parent
		// scalars first or they are parsed as fields of the last child table.
		for (const [key, value] of entries)
			if (
				!isTable(value) &&
				!(
					Array.isArray(value) &&
					value.every((item) => item && typeof item === "object")
				)
			)
				lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
		for (const [key, value] of entries) {
			if (
				Array.isArray(value) &&
				value.every((item) => item && typeof item === "object")
			) {
				for (const item of value) {
					lines.push(`\n[[${prefix ? `${prefix}.` : ""}${tomlKey(key)}]]`);
					writeTable(item as Record<string, unknown>, "");
				}
			} else if (isTable(value)) {
				const name = prefix ? `${prefix}.${tomlKey(key)}` : tomlKey(key);
				lines.push(`\n[${name}]`);
				writeTable(value, name);
			}
		}
	};
	writeTable(document, "");
	return `${lines.join("\n").replace(/^\n/, "")}\n`;
}

function deepMerge<T extends object>(base: T, overlay: unknown): T {
	const merged = structuredClone(base) as Record<string, unknown>;
	if (!overlay || typeof overlay !== "object" || Array.isArray(overlay))
		return merged as T;
	for (const [key, value] of Object.entries(overlay)) {
		// TOML tables can carry a literal "__proto__" key; merging it would
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
	projects: { root: string; max_depth: number };
	telemetry: { capture_content: boolean };
	ui: { theme: string; selection_height: number };
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
	projects: { root: "~/development", max_depth: 3 },
	telemetry: { capture_content: true },
	ui: { theme: "catppuccin", selection_height: 10 },
	wiki: { root: "~/.config/agentic-coding/wiki" },
};

export interface ConfigProvenance {
	source: "default" | "environment" | "user" | "legacy" | "project";
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

function repositoryConfigRoot(repository: string): string | undefined {
	try {
		const result = Bun.spawnSync(
			["git", "-C", path.resolve(repository), "rev-parse", "--git-common-dir"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		if (result.exitCode !== 0) return undefined;
		const common = result.stdout.toString().trim();
		if (!common) return undefined;
		const absolute = path.resolve(repository, common);
		return path.basename(absolute) === ".git"
			? path.dirname(absolute)
			: absolute;
	} catch {
		return undefined;
	}
}

/** Resolve config without changing cwd. `repository` is the only source of a
 * project overlay; omit it for the caller's legacy cwd-compatible behavior. */
type ConfigOptions =
	| string
	| { repository?: string; repositoryIndependent?: boolean };

export function loadConfigWithProvenance(
	options: ConfigOptions = {},
): ResolvedWorkflowConfig {
	const normalized =
		typeof options === "string" ? { repository: options } : options;
	const envPath = process.env.HERDR_WORKFLOW_CONFIG;
	if (envPath) {
		return {
			config: deepMerge(
				structuredClone(DEFAULT_CONFIG),
				Bun.TOML.parse(fs.readFileSync(envPath, "utf8")) as WorkflowConfig,
			),
			provenance: { source: "environment", files: [envPath] },
		};
	}
	const candidates = [
		path.join(os.homedir(), ".config", "agentic-coding", "config.toml"),
		path.join(os.homedir(), ".pi", "agent", "herdr-workflow.toml"),
	];
	const file = candidates.find((candidate) => fs.existsSync(candidate));
	let cfg = deepMerge(
		structuredClone(DEFAULT_CONFIG),
		file ? Bun.TOML.parse(fs.readFileSync(file, "utf8")) : {},
	);
	const root = normalized.repositoryIndependent
		? undefined
		: (repositoryConfigRoot(normalized.repository ?? process.cwd()) ??
			(normalized.repository
				? path.resolve(normalized.repository)
				: process.cwd()));
	const projectConfig = root
		? path.join(root, ".pi", "herdr-workflow.toml")
		: undefined;
	if (projectConfig && fs.existsSync(projectConfig)) {
		cfg = deepMerge(
			cfg,
			Bun.TOML.parse(fs.readFileSync(projectConfig, "utf8")),
		);
	}
	return {
		config: cfg,
		provenance: {
			source:
				projectConfig && fs.existsSync(projectConfig)
					? "project"
					: file
						? file === candidates[0]
							? "user"
							: "legacy"
						: "default",
			files: [
				...(file ? [file] : []),
				...(projectConfig && fs.existsSync(projectConfig)
					? [projectConfig]
					: []),
			],
			...(root ? { repository: root } : {}),
		},
	};
}

export function loadConfig(options?: ConfigOptions): WorkflowConfig {
	return loadConfigWithProvenance(options).config;
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
 * 2. The winning base file is the FIRST EXISTING of canonical user > legacy —
 *    mirroring loadConfig's candidates.find; lower-priority base files are
 *    never read when a higher one exists.
 * 3. A project file supplying [agents] deep-merges over that base, so it is
 *    the target whenever it exists with an agents section.
 * 4. Otherwise the winning base file is the target (created if none exists),
 *    preferring the canonical user config path. */
export function selectAgentsConfigPath(
	envPath: string | undefined,
	home: string,
	cwd: string,
): string {
	if (envPath) return envPath;
	const baseCandidates = [
		path.join(home, ".config", "agentic-coding", "config.toml"),
		path.join(home, ".pi", "agent", "herdr-workflow.toml"),
	];
	const project = path.join(cwd, ".pi", "herdr-workflow.toml");
	if (fs.existsSync(project) && "agents" in readToml(project)) return project;
	const base = baseCandidates.find((candidate) => fs.existsSync(candidate));
	if (base) return base;
	if (fs.existsSync(project)) return project;
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
): string[] {
	const target = selectAgentsConfigPath(undefined, home, cwd);
	if (target !== path.join(cwd, ".pi", "herdr-workflow.toml")) return [];
	return [
		path.join(home, ".config", "agentic-coding", "config.toml"),
		path.join(home, ".pi", "agent", "herdr-workflow.toml"),
	].filter(
		(candidate) => fs.existsSync(candidate) && "agents" in readToml(candidate),
	);
}
export function readToml(file: string): Record<string, unknown> {
	return fs.existsSync(file)
		? (Bun.TOML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>)
		: {};
}
/** Read-modify-write the config file backing the agents section. The whole
 * file is rewritten with the local TOML serializer; hand comments in managed
 * files are not preserved (accepted trade-off, documented in the modal help). */
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
	const document = readToml(file);
	if (
		!document.agents ||
		typeof document.agents !== "object" ||
		Array.isArray(document.agents)
	)
		document.agents = {};
	mutate(document.agents as Record<string, unknown>);
	const contents = stringifyToml(document);
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
