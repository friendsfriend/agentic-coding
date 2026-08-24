// Seams: the only place that touches git, subprocess, time, network, and config I/O.
// Herdr access itself lives in ../herdr-client.ts (the single shared `.result` parser).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Herdr } from "../herdr-client.ts";

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
};

export function loadConfig(): WorkflowConfig {
	// Canonical location: ~/.config/agentic-coding/config.toml. Legacy
	// ~/.pi/agent/herdr-workflow.toml (stow-based installs) still consulted as a
	// fallback; HERDR_WORKFLOW_CONFIG always wins.
	const envPath = process.env.HERDR_WORKFLOW_CONFIG;
	if (envPath) {
		// Full replacement: no legacy fallback and no project overlay, so the
		// env config unambiguously wins and dashboard write-backs take effect.
		return deepMerge(
			structuredClone(DEFAULT_CONFIG),
			Bun.TOML.parse(fs.readFileSync(envPath, "utf8")) as WorkflowConfig,
		);
	}
	const candidates = [
		path.join(os.homedir(), ".config", "agentic-coding", "config.toml"),
		path.join(os.homedir(), ".pi", "agent", "herdr-workflow.toml"),
	];
	const file = candidates.find((candidate) => fs.existsSync(candidate));
	const parsed = file
		? (Bun.TOML.parse(fs.readFileSync(file, "utf8")) as WorkflowConfig)
		: {};
	let cfg = deepMerge(structuredClone(DEFAULT_CONFIG), parsed);
	const projectConfig = path.join(process.cwd(), ".pi", "herdr-workflow.toml");
	if (fs.existsSync(projectConfig)) {
		cfg = deepMerge(
			cfg,
			Bun.TOML.parse(fs.readFileSync(projectConfig, "utf8")),
		);
	}
	return cfg;
}

/** Resolve the config file that dashboard edits write back to (see
 * selectAgentsConfigPath for the precedence rules). */
export function agentsConfigPath(): string {
	return selectAgentsConfigPath(
		process.env.HERDR_WORKFLOW_CONFIG,
		os.homedir(),
		process.cwd(),
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
 * file is rewritten with Bun.TOML.stringify; hand comments in managed files
 * are not preserved (accepted trade-off, documented in the modal help). */
export function saveAgentsSection(
	mutate: (agents: Record<string, unknown>) => void,
): void {
	const file = agentsConfigPath();
	const document = readToml(file);
	if (
		!document.agents ||
		typeof document.agents !== "object" ||
		Array.isArray(document.agents)
	)
		document.agents = {};
	mutate(document.agents as Record<string, unknown>);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, Bun.TOML.stringify(document) ?? "");
}

export interface Context {
	config: WorkflowConfig;
	herdr: Herdr;
	git: Git;
	clock: Clock;
	exporter: Exporter;
}
