import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ENVIRONMENT_URL_ENV } from "../agent-host/environment-capability.ts";
import { ASSIGNMENT_TOOL_SURFACE } from "../agent-host/tool-surface.ts";
import type { Assignment } from "../contracts/workflow.ts";
import { AGENT_DEF_DIR } from "./paths.ts";
import { selectProtocol } from "./prompt-sections.ts";
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
	"No agentic-coding server was reachable for this run's configuration, so the environment tools (`env_*`), the browser tools (`browser_*`) and the debug tools (`otel_query`, `db_query`, `http_request`) fail on every call.",
	"Do not work around it with `docker`/`kubectl` or by reasoning about a run you did not make: say in your handoff that they were unavailable, and hand off `blocked` when the task cannot be done without them (an `env-setup` workflow cannot start, build or test the definitions it drafts).",
].join("\n");

/** What each interaction mode means for the run, one line beside
 * `Interaction:`. */
const INTERACTION_GUIDANCE: Readonly<
	Record<Assignment["interaction"], string>
> = {
	"developer-dialogue":
		"Visible discussion is allowed; use `developer_question` only for material unresolved decisions.",
	silent: "Report through the artifact and the handoff; no chat summary.",
};

// The tool surface (efficiency backlog item 14): the same split and the same
// batching rule the tool descriptions carry, taken from the module that owns
// them (`agent-host/tool-surface.ts`) instead of restated here, so the two
// surfaces cannot drift apart. The rule lived only in the protocol document,
// which is sent once at the top of an 18 kB prompt; the dynamic envelope is the
// one part a follow-up attempt or round re-sends, so it travels here, in the
// first lines of every assignment. It names no tool a run may lack: `codemode`
// is conditioned on the run's own tool set, and `edit`/`write` are never named,
// because a read-only run has neither.

/** The `## Inputs` body. A one-line input is a bullet; a multi-line input is an
 * untrusted-context block with its own heading (prior dialogue, a research
 * handoff, an earlier round's findings), so it is rendered as its own blank-line
 * separated section — its heading stays a heading, and the engine-owned bullets
 * after it do not read as part of it. */
function renderInputs(inputs: readonly string[]): string[] {
	const lines: string[] = [];
	let afterBlock = false;
	for (const item of inputs) {
		const block = item.includes("\n");
		if (block || afterBlock) lines.push("");
		lines.push(block ? item : `- ${item}`);
		afterBlock = block;
	}
	return lines;
}

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

/** The blocks a first assignment is assembled from, before they are joined:
 * the protocol as rendered for the role, the role's instruction assets, and
 * the dynamic envelope. The prompt inventory measures these parts. */
export interface AssignmentParts {
	protocol: string;
	/** The protocol's digest input: the whole pinned file, whatever sections
	 * the role receives. */
	protocolHash: string;
	assets: readonly string[];
	dynamic: string;
}

export function renderAssignment(
	step: Readonly<StepDefinition>,
	assignment: Assignment,
	assetRoot = path.join(AGENT_DEF_DIR, "instructions"),
	traits?: WorkflowFamilyTraits,
): RenderedAssignment {
	const parts = assignmentParts(step, assignment, assetRoot, traits);
	const prompt = (
		isFollowUp(assignment)
			? [followUpPreamble(assetRoot), parts.dynamic]
			: [parts.protocol, ...parts.assets, parts.dynamic]
	).join("\n\n---\n\n");
	const bytes = Buffer.byteLength(prompt);
	if (bytes > MAX_ASSIGNMENT_BYTES)
		throw new Error(`assignment exceeds ${MAX_ASSIGNMENT_BYTES} bytes`);
	return {
		prompt,
		bytes,
		digest: createHash("sha256")
			.update(`${parts.protocolHash}\0${prompt}`)
			.digest("hex"),
	};
}

export function assignmentParts(
	step: Readonly<StepDefinition>,
	assignment: Assignment,
	assetRoot = path.join(AGENT_DEF_DIR, "instructions"),
	traits?: WorkflowFamilyTraits,
): AssignmentParts {
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
	const pinnedProtocol = readPinnedAsset(
		"workflow-agent-protocol.md",
		step.instructionDigests[protocolIndex],
		assetRoot,
	);
	const protocolHash = createHash("sha256")
		.update(pinnedProtocol)
		.digest("hex");
	// The pinned file holds every section; the role receives the core and the
	// sections its step declares for it.
	const protocol = selectProtocol(
		pinnedProtocol,
		step.behavior?.protocolSections?.({ role: assignment.role, traits }),
	);
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
		ASSIGNMENT_TOOL_SURFACE,
		"",
		"## Objective",
		assignment.objective,
		"",
		`Interaction: ${assignment.interaction}`,
		INTERACTION_GUIDANCE[assignment.interaction],
		"",
		// An env-setup run without its tools cannot do the job it was assigned;
		// every other role reads it as the ordinary degraded case.
		...(!assignment.environment?.[ENVIRONMENT_URL_ENV]
			? [NO_ENVIRONMENT_TOOLS, ""]
			: []),
		"## Inputs",
		...(assignment.inputs.length
			? renderInputs(assignment.inputs)
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
											"Payload: non-empty Markdown `report` with Summary, Environment, Reproduction, Expected, Actual, Findings, Code changes, Open questions. If unreproducible, hand off `blocked` with a message.",
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
	return { protocol, protocolHash, assets, dynamic };
}
