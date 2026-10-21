// Prompt inventory (slim-agent-prompts): renders the generation-1 assignment of
// every agent step and role through the production renderer and reports the
// bytes of each part, so a prompt's size is a measured number a test can bound
// instead of an impression. Pure: it reads only the embedded instruction assets
// and the built-in registry, never a store, a configuration root or `~/.pi`.
//
// The numbers are the *static* prompt: run data (task line, step input, plan,
// evidence, prior dialogue) is empty, so a row is what the template alone costs.
import { ENVIRONMENT_URL_ENV } from "../agent-host/environment-capability.ts";
import type { Assignment } from "../contracts/workflow.ts";
import { assignmentParts, renderAssignment } from "./assignment.ts";
import { registerBuiltins } from "./definitions/registerBuiltins.ts";
import { VERIFIER_ROLES } from "./steps/verification.ts";

export const PROMPT_FAMILIES = [
	"planner",
	"fusion-planner",
	"consolidator",
	"worker",
	"rebase",
	"triage",
	"verifier",
	"archive",
	"researcher",
	"wiki",
	"stage-wiki",
	"debug",
	"env-setup",
	"stage-planner",
	"stage-tester",
] as const;
export type PromptFamily = (typeof PROMPT_FAMILIES)[number];

export interface PromptRole {
	readonly stepId: string;
	/** The role as the engine assigns it (`planner-N` is represented by
	 * `planner-1`). */
	readonly role: string;
	readonly family: PromptFamily;
}

/** Every agent step and role of the built-in registry that receives the
 * managed workflow protocol. A test pins that no registered agent step with an
 * instruction asset is missing here. */
export const PROMPT_ROLES: readonly PromptRole[] = [
	{ stepId: "core.plan", role: "planner", family: "planner" },
	{ stepId: "fusion.plan", role: "planner-1", family: "fusion-planner" },
	{
		stepId: "fusion.consolidate",
		role: "consolidator",
		family: "consolidator",
	},
	{ stepId: "core.implementation", role: "worker", family: "worker" },
	{ stepId: "core.rebase", role: "worker", family: "rebase" },
	{ stepId: "core.triage", role: "triage", family: "triage" },
	...VERIFIER_ROLES.map(
		(role): PromptRole => ({
			stepId: "core.verification",
			role,
			family: "verifier",
		}),
	),
	{ stepId: "core.archive", role: "archive", family: "archive" },
	{ stepId: "core.research", role: "researcher", family: "researcher" },
	{ stepId: "core.wiki", role: "wiki", family: "wiki" },
	{ stepId: "core.wiki", role: "research-wiki", family: "wiki" },
	{ stepId: "core.wiki", role: "stage-wiki", family: "stage-wiki" },
	{ stepId: "debug.investigate", role: "debug", family: "debug" },
	{ stepId: "setup.author", role: "env-setup", family: "env-setup" },
	{ stepId: "stage.plan", role: "stage-planner", family: "stage-planner" },
	{ stepId: "stage.execute", role: "stage-tester", family: "stage-tester" },
	{ stepId: "stage.replay", role: "stage-tester", family: "stage-tester" },
];

/** Byte budget of a role family's static first assignment (protocol, role
 * instruction and envelope together). A budget is a ceiling, not a target: it
 * is the measured size rounded up, so growth fails a test and a deliberate
 * addition is a reviewed one-line change here. */
export const PROMPT_BUDGETS: Readonly<Record<PromptFamily, number>> = {
	planner: 10 * 1024,
	"fusion-planner": 7 * 1024,
	consolidator: 8 * 1024,
	worker: 7 * 1024,
	rebase: 6 * 1024,
	triage: 7.5 * 1024,
	verifier: 8.5 * 1024,
	archive: 6.5 * 1024,
	researcher: 10 * 1024,
	wiki: 10.5 * 1024,
	"stage-wiki": 5 * 1024,
	debug: 9.5 * 1024,
	"env-setup": 10.5 * 1024,
	"stage-planner": 8.5 * 1024,
	"stage-tester": 10 * 1024,
};

/** Budget of the `codemode` system-prompt section for the full workflow tool
 * set (every tool name with the first sentence of its description). */
export const CODEMODE_SECTION_BUDGET = 7.5 * 1024;

export interface PromptPart {
	readonly name: string;
	readonly bytes: number;
}

export interface PromptRow {
	readonly stepId: string;
	readonly role: string;
	readonly family: PromptFamily;
	readonly protocol: readonly PromptPart[];
	readonly protocolBytes: number;
	readonly roleBytes: number;
	readonly envelope: readonly PromptPart[];
	readonly envelopeBytes: number;
	/** Separators between the blocks. */
	readonly glueBytes: number;
	readonly totalBytes: number;
	readonly tokens: number;
	/** `renderAssignment`'s prompt, kept so a caller can print or search it. */
	readonly prompt: string;
}

export const tokensForBytes = (bytes: number): number => Math.ceil(bytes / 4);

const bytesOf = (text: string): number => Buffer.byteLength(text);

/** Splits a rendered block on its `## ` headings: the text before the first
 * heading is the block's head (its `# ` title and any preamble). */
export function splitSections(
	text: string,
	headName: string,
): readonly PromptPart[] {
	const parts: PromptPart[] = [];
	const chunks = text.split(/\n(?=## )/);
	chunks.forEach((chunk, index) => {
		const heading = /^## (.+)$/m.exec(chunk.split("\n")[0] ?? "");
		parts.push({
			name: index === 0 && !heading ? headName : (heading?.[1] ?? headName),
			// The newline the split consumed belongs to the section.
			bytes: bytesOf(chunk) + (index === 0 ? 0 : 1),
		});
	});
	return parts;
}

/** A realistic output path: the engine's path is ~150 bytes, which the
 * envelope prints twice. */
const OUTPUT_PATH =
	"/Users/example/worktrees/repository/.herdr-workflow/workflow-id/runs/00000000-0000-0000-0000-000000000000.output.json";

export function inventoryAssignment(
	stepId: string,
	role: string,
	output: { id: string; version: number } | undefined,
): Assignment {
	return {
		protocolVersion: 1,
		workflowId: "workflow-id",
		runId: "00000000-0000-0000-0000-000000000000",
		generation: 1,
		stepId,
		role,
		objective: `Complete ${stepId} for workflow-id.`,
		interaction: "developer-dialogue",
		inputs: [],
		permissions: ["read and edit repository"],
		checks: ["focused tests only"],
		...(output
			? {
					output: {
						path: OUTPUT_PATH,
						schemaId: output.id,
						schemaVersion: output.version,
						maxBytes: 512 * 1024,
					},
				}
			: {}),
		allowedOutcomes: ["complete", "blocked", "failed"],
		environment: {
			[ENVIRONMENT_URL_ENV]: "http://127.0.0.1:0",
		} as unknown as Assignment["environment"],
	};
}

export function measureRole(
	registry: ReturnType<typeof registerBuiltins>,
	entry: PromptRole,
): PromptRow {
	const step = registry.step(entry.stepId);
	const assignment = inventoryAssignment(entry.stepId, entry.role, step.output);
	const rendered = renderAssignment(step, assignment);
	const parts = assignmentParts(step, assignment);
	const protocol = splitSections(parts.protocol, "protocol core");
	const protocolBytes = bytesOf(parts.protocol);
	const roleBytes = parts.assets.reduce((sum, item) => sum + bytesOf(item), 0);
	const envelope = splitSections(parts.dynamic, "envelope header");
	const envelopeBytes = bytesOf(parts.dynamic);
	const glueBytes = rendered.bytes - protocolBytes - roleBytes - envelopeBytes;
	return {
		stepId: entry.stepId,
		role: entry.role,
		family: entry.family,
		protocol,
		protocolBytes,
		roleBytes,
		envelope,
		envelopeBytes,
		glueBytes,
		totalBytes: rendered.bytes,
		tokens: tokensForBytes(rendered.bytes),
		prompt: rendered.prompt,
	};
}

/** One row per agent step and role of the built-in registry. */
export function measureInventory(
	registry = registerBuiltins(),
): readonly PromptRow[] {
	return PROMPT_ROLES.map((entry) => measureRole(registry, entry));
}

/** The protocol section names across all rows, in first-seen order. */
export function protocolSectionNames(rows: readonly PromptRow[]): string[] {
	const names: string[] = [];
	for (const row of rows)
		for (const part of row.protocol)
			if (!names.includes(part.name)) names.push(part.name);
	return names;
}

const kb = (bytes: number): string => (bytes / 1024).toFixed(1);

/** The inventory as a Markdown table: one row per step and role, with the
 * protocol, role instruction, envelope and total sizes. */
export function renderInventoryMarkdown(rows: readonly PromptRow[]): string {
	const lines = [
		"| Step | Role | Protocol | Role brief | Envelope | Total | ≈ tokens | Budget |",
		"|---|---|---|---|---|---|---|---|",
	];
	for (const row of rows) {
		lines.push(
			`| ${row.stepId} | ${row.role} | ${row.protocolBytes} | ${row.roleBytes} | ${row.envelopeBytes + row.glueBytes} | ${row.totalBytes} | ${row.tokens} | ${kb(PROMPT_BUDGETS[row.family])} KB |`,
		);
	}
	const sections = protocolSectionNames(rows);
	const groups = new Map<string, string[]>();
	for (const row of rows) {
		const signature = sections
			.map(
				(name) => row.protocol.find((part) => part.name === name)?.bytes ?? 0,
			)
			.join(" | ");
		groups.set(signature, [
			...(groups.get(signature) ?? []),
			`${row.stepId}:${row.role}`,
		]);
	}
	lines.push(
		"",
		"Protocol sections (bytes), rows with identical protocol grouped:",
		"",
	);
	lines.push(`| ${sections.join(" | ")} | Roles |`);
	lines.push(`|${sections.map(() => "---").join("|")}|---|`);
	for (const [signature, roles] of groups)
		lines.push(`| ${signature} | ${roles.join(", ")} |`);
	return lines.join("\n");
}
