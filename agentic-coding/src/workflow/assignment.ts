import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ENVIRONMENT_URL_ENV } from "../agent-host/environment-capability.ts";
import type { Assignment } from "../contracts/workflow.ts";
import { AGENT_DEF_DIR } from "./paths.ts";
import type { StepDefinition, WorkflowFamilyTraits } from "./registry.ts";

export const MAX_ASSIGNMENT_BYTES = 96 * 1024;

/** What a run is told when it has no environment capability at all: no server
 * was running for its configuration, so the `env_*`, `browser_*` and debug tools
 * are registered but cannot act. Stated up front, with what to do about it, so a
 * run never reports a start, a build or a test it could not have made
 * (fix-env-tools-for-all-runs). */
const NO_ENVIRONMENT_TOOLS = [
	"## Environment tools: unavailable",
	"",
	"No agentic-coding server was reachable for this run's configuration, so the environment tools (`env_list`, `env_start`, `env_status`, `env_stop`, `env_build`, `env_test`, `env_logs`), the browser tools (`browser_*`) and the debug tools (`otel_query`, `db_query`, `http_request`) have no capability: every call to them fails.",
	"Do not work around this by shelling out to `docker`/`kubectl` yourself or by reasoning about a run you did not make: say in your handoff that the environment tools were unavailable, and hand off `blocked` when the task cannot be done without them (an `env-setup` workflow cannot start, build or test the definitions it drafts).",
].join("\n");

/** The inspection split and the batching rule, in the assignment's first lines
 * (efficiency backlog item 14). The rule lived only in the protocol document,
 * which is sent once at the top of an 18 kB prompt; the dynamic envelope is the
 * one part a follow-up attempt or round re-sends, so the rule travels here.
 *
 * The wording matches the `read`/`grep`/`bash`/`codemode` descriptions
 * (`agent-host/tool-surface.ts`) and names no tool a run may lack: `codemode`
 * is conditioned on the run's own tool set, and `edit`/`write` are never named,
 * because a read-only run has neither. */
const TOOL_SURFACE = [
	"## Tool surface",
	"",
	"`read` (with `offset`/`limit`) and `grep` (with a `path` filter) are the default way to inspect code; `bash` is for builds, tests and `openspec`; `codemode`, when this run offers it, chains a search → filter → summarise pipeline into one turn. Emit every independent call for a step in one message rather than one call per turn — each turn re-sends the whole conversation.",
].join("\n");

export interface RenderedAssignment {
	prompt: string;
	digest: string;
	bytes: number;
}
function readPinnedAsset(
	name: string,
	expected: string,
	assetRoot: string,
): string {
	const root = fs.realpathSync(assetRoot);
	const candidate = path.resolve(root, name);
	if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`))
		throw new Error(`instruction asset escapes root: ${name}`);
	const stat = fs.lstatSync(candidate);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error(`invalid instruction asset: ${name}`);
	const content = fs.readFileSync(candidate, "utf8");
	const actual = createHash("sha256").update(content).digest("hex");
	if (actual !== expected) throw new Error(`instruction pin mismatch: ${name}`);
	return content.trim();
}
/** What a run is told when its conversation already carries the standing
 * instructions, so the turn carries only what changed for the round. The
 * protocol and the role asset are ~15k characters of invariants the agent
 * already has — re-sending them every round is the largest avoidable part of a
 * verifier's context, and it is re-read on every turn of the round.
 *
 * The pinned asset copy is named as the recovery path: a compacted or resumed
 * session that no longer holds the protocol can re-read it there instead of
 * running a whole round without it. */
function followUpPreamble(assetRoot: string): string {
	return [
		"# Follow-up assignment",
		"",
		"The managed workflow protocol and your role instructions were delivered in the first message of this conversation and still apply unchanged; this message carries only what this round changes.",
		`If this conversation no longer holds them — a compacted or resumed session — re-read them from \`${assetRoot}/workflow-agent-protocol.md\` and the role file beside it. Nothing else needs to be read from disk: the inputs, checks, output contract and handoff below are the current ones.`,
	].join("\n");
}

/** Whether this assignment is delivered into a conversation that already got
 * the standing instructions, or opens one. A run's generation is the step's
 * attempt, and the conversation is named per (step, role): a generation above
 * 1 means an earlier generation of the same step and role already ran here, so
 * the protocol and role asset are already in the transcript. */
function isFollowUp(assignment: Assignment): boolean {
	return assignment.generation > 1;
}

export function renderAssignment(
	step: Readonly<StepDefinition>,
	assignment: Assignment,
	assetRoot = path.join(AGENT_DEF_DIR, "instructions"),
	traits?: WorkflowFamilyTraits,
): RenderedAssignment {
	if (
		assignment.stepId !== step.id ||
		!assignment.runId ||
		!assignment.role ||
		!assignment.objective.trim()
	)
		throw new Error("invalid assignment identity");
	const protocolIndex = step.instructionAssets.indexOf(
		"workflow-agent-protocol.md",
	);
	if (protocolIndex < 0) throw new Error("missing pinned workflow protocol");
	const protocol = readPinnedAsset(
		"workflow-agent-protocol.md",
		step.instructionDigests[protocolIndex],
		assetRoot,
	);
	const protocolHash = createHash("sha256").update(protocol).digest("hex");
	const roleAsset = assignment.role.replace(/-verifier$/, "");
	// Two role families select one variant asset out of several pinned for the
	// step, instead of every asset unconditionally: verification roles pick
	// their own severity-specific file, and the wiki roles ('wiki' for
	// discovery-based openspec/implementation drafting, 'research-wiki' for
	// directive-first research-handoff drafting) pick their own approach file.
	// Any other pinned asset for the step is always included.
	const wikiAsset = step.behavior?.instructionAssetForRole?.({
		role: assignment.role,
		traits,
	});
	const assets = step.instructionAssets.flatMap((name, index) => {
		if (name === "workflow-agent-protocol.md") return [];
		if (name.startsWith("verification-"))
			return name === `verification-${roleAsset}.md`
				? [readPinnedAsset(name, step.instructionDigests[index], assetRoot)]
				: [];
		if (name.startsWith("wiki-"))
			return name === wikiAsset
				? [readPinnedAsset(name, step.instructionDigests[index], assetRoot)]
				: [];
		return [readPinnedAsset(name, step.instructionDigests[index], assetRoot)];
	});
	const handoff = assignment.allowedOutcomes.includes("complete")
		? "agentic-coding workflow handoff --outcome complete" +
			(assignment.output ? ' --artifact "$HERDR_OUTPUT"' : "")
		: undefined;
	const payloadExample =
		assignment.output?.schemaId === "core.triage-plan"
			? {
					roles: [
						{
							role: "quality-verifier",
							reason: "why this role is needed",
							files: ["relative/path.ts"],
						},
					],
				}
			: assignment.output?.schemaId === "core.findings"
				? {
						findings: [
							{
								id: "ROLE-001",
								severity: "critical",
								detail: "actionable finding",
								path: "relative/path.ts",
							},
						],
					}
				: assignment.output?.schemaId === "core.plan-draft"
					? {
							approach: "one-paragraph implementation strategy",
							files: [
								{
									path: "relative/path.ts",
									change: "concrete change for this file",
								},
							],
							risks: [{ detail: "what could break" }],
							questions: [{ detail: "unresolved decision" }],
						}
					: { result: "step-specific JSON value" };

	const dynamic = [
		"# Run assignment",
		"",
		`Protocol: ${assignment.protocolVersion}`,
		`Workflow: ${assignment.workflowId}`,
		`Run: ${assignment.runId}`,
		`Generation: ${assignment.generation}`,
		`Step: ${assignment.stepId}`,
		`Role: ${assignment.role}`,
		"",
		TOOL_SURFACE,
		"",
		"## Objective",
		assignment.objective,
		"",
		`Interaction: ${assignment.interaction}`,
		"",
		// An env-setup run without its tools cannot do the job it was assigned;
		// every other role reads it as the ordinary degraded case.
		...(!assignment.environment?.[ENVIRONMENT_URL_ENV]
			? [NO_ENVIRONMENT_TOOLS, ""]
			: []),
		"## Inputs",
		...(assignment.inputs.length
			? assignment.inputs.map((item) => `- ${item}`)
			: ["- none"]),
		"",
		"## Permissions",
		...assignment.permissions.map((item) => `- ${item}`),
		"",
		"## Required checks",
		...assignment.checks.map((item) => `- ${item}`),
		"",
		"## Output contract",
		...(assignment.output
			? [
					`Path: ${assignment.output.path}`,
					`Schema: ${assignment.output.schemaId}@${assignment.output.schemaVersion}`,
					`Maximum bytes: ${assignment.output.maxBytes}`,
					"Write exactly this envelope shape:",
					"```json",
					JSON.stringify(
						{
							runId: assignment.runId,
							schemaId: assignment.output.schemaId,
							schemaVersion: assignment.output.schemaVersion,
							payload: payloadExample,
						},
						null,
						2,
					),
					"```",
					...(assignment.output.schemaId === "core.triage-plan"
						? [
								"Payload: `roles` array; each item requires string `role`, non-empty string `reason`, and non-empty repository-relative string array `files`; optional `hunks` maps files to hunk IDs 1..8.",
							]
						: assignment.output.schemaId === "core.findings"
							? [
									"Payload: `findings` array; each item requires unique string `id`, `severity` (`critical`, `warning`, or `info`), non-empty Markdown `detail`, repository-relative `path`, and integer `line` (1-based line in the current file). Optional `recommendation` is Markdown describing a concrete recommended fix; include enough rationale and implementation detail to make it actionable.",
								]
							: assignment.output.schemaId === "core.plan-draft"
								? [
										"Payload: non-empty string `approach`; non-empty `files` array of `{ path, change }` items with repository-relative paths; `risks` and `questions` arrays of `{ detail }` items.",
									]
								: assignment.output.schemaId === "core.debug-report"
									? [
											"Payload: non-empty string `report` — the whole markdown investigation report, with the headings Summary, Environment, Reproduction, Expected, Actual, Findings, Code changes, and Open questions. Hand off `blocked` with a message when the behavior cannot be reproduced at all.",
										]
									: ["Payload: JSON value required by step instructions."]),
				]
			: ["No output artifact."]),
		"",
		`Allowed outcomes: ${assignment.allowedOutcomes.join(", ")}`,
		"",
		"## Handoff",
		...(step.behavior?.handoffNote ?? [
			"Finish the run by reporting exactly one outcome with the workflow CLI:",
		]),
		"```bash",
		...(handoff ? [handoff] : []),
		'agentic-coding workflow handoff --outcome blocked --message "reason"',
		'agentic-coding workflow handoff --outcome failed --message "diagnostic"',
		"```",
	].join("\n");
	const prompt = (
		isFollowUp(assignment)
			? [followUpPreamble(assetRoot), dynamic]
			: [protocol, ...assets, dynamic]
	).join("\n\n---\n\n");
	const bytes = Buffer.byteLength(prompt);
	if (bytes > MAX_ASSIGNMENT_BYTES)
		throw new Error(`assignment exceeds ${MAX_ASSIGNMENT_BYTES} bytes`);
	return {
		prompt,
		bytes,
		digest: createHash("sha256")
			.update(`${protocolHash}\0${prompt}`)
			.digest("hex"),
	};
}
