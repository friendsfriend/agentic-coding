// The pinned-stage workflow's agent steps. The browser server enforces the
// stage pin and stage access policy independently; these behaviors supply the
// least-privilege roles and the structured plan/report contracts. Pure domain
// module: it consumes only supplied validated evidence
// (`stageReplayEligible`/`stageReplayEvidence`), never the evidence store or
// the stage-blocks registry itself — those reads happen at the impure
// boundary (`workflow/runtime/store.ts`, `workflow/runtime/reducers/agent-handoff.ts`).

import {
	proofProvesBlock,
	type StageBlockProofFacts,
} from "../../contracts/stage-block-proof.ts";
import type {
	JsonValue,
	WorkflowActionView,
	WorkflowSnapshot,
} from "../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import {
	type StageTestPlan,
	type StageTestReport,
	stageTestPlan,
	stageTestReport,
} from "../definitions/contracts.ts";
import type { AgentCompletionContext, StepBehavior } from "./types.ts";

export const STAGE_TEST_PLANNER_ROLE = "stage-planner";
export const STAGE_TESTER_ROLE = "stage-tester";
export const STAGE_TEST_WIKI_ROLE = "stage-wiki";

const planFor = (value: JsonValue | undefined): StageTestPlan =>
	stageTestPlan.parse(value);

/** The block decision of one route step: exactly one of a block, a block the
 * tester is to author, a block to adjust, or a stated reason why the step cannot
 * be a block at all.
 *
 * This is checked when a plan is *authored* and never by the persisted schema
 * decoder: `metadata.stageTestPlan` snapshots written before the
 * `author-stage-blocks-as-data` change have exploratory route steps with none of
 * the four fields, and a decoder filter would make those runs undecodable — and
 * therefore unresumable — instead of letting them finish the way they were
 * approved (`MIG-001`). */
export function stagePlanDecisionIssues(plan: StageTestPlan): string[] {
	const issues: string[] = [];
	plan.route.forEach((step, index) => {
		const named = [
			step.block === undefined ? undefined : "block",
			step.blockToCreate === undefined ? undefined : "blockToCreate",
			step.blockToAdjust === undefined ? undefined : "blockToAdjust",
			step.noBlockReason === undefined ? undefined : "noBlockReason",
		].filter((value): value is string => value !== undefined);
		if (named.length === 0)
			issues.push(
				`route step ${step.id} (index ${index}) names no block: add block, blockToCreate, blockToAdjust, or a noBlockReason that explains why this step cannot be a block`,
			);
		else if (named.length > 1)
			issues.push(
				`route step ${step.id} (index ${index}) names ${named.join(" and ")}: exactly one of block, blockToCreate, blockToAdjust or noBlockReason is allowed`,
			);
	});
	return issues;
}

/** One approved or drafted block, as the plan gate needs it. The registry is
 * read at the impure boundary and passed in, so this stays pure. */
export interface StagePlanBlockFacts {
	readonly id: string;
	readonly version: string;
	readonly app: string;
	readonly roles: readonly string[];
	readonly effects: readonly string[];
	readonly title: string;
}

/** The block-effect and application rules a *plan* has to satisfy before the
 * developer is asked to approve it (`plan-blocks` requirement, `OSV-013`).
 *
 * The plan states which block each route step will run, so the stage policy has
 * to be enforced here and not only when the block is finally executed:
 *
 * - a step that names an approved block must name one the stage can run — an
 *   unknown id is a plan that cannot execute;
 * - the block's declared application must be one the pinned stage declares,
 *   exactly as a route step's own `application` must be;
 * - a destructive block is never runnable, whatever the plan says;
 * - a write or destructive block counts as data creation, so the plan has to
 *   declare `createsData`, which is what routes a writable stage through the
 *   `when-writing` approval gate.
 *
 * `blocks` holds the composed registry's blocks (checked-in plus approved plus
 * this run's drafts), so a plan may name a draft it means to adjust. A
 * `blockToCreate`/`blockToAdjust` intent whose id is not there yet is fine —
 * that is what authoring means — but once the id *is* there, its scope applies. */
export function stagePlanBlockIssues(input: {
	plan: StageTestPlan;
	blocks?: readonly StagePlanBlockFacts[];
	stageApps?: readonly string[];
}): string[] {
	if (input.blocks === undefined) return [];
	const issues: string[] = [];
	const known = new Map(input.blocks.map((block) => [block.id, block]));
	const apps =
		input.stageApps === undefined ? undefined : new Set(input.stageApps);
	for (const step of input.plan.route) {
		const chosen = step.block ?? step.blockToAdjust;
		const intent = step.blockToCreate;
		const named = chosen?.id ?? intent?.id;
		if (named === undefined) continue;
		const block = known.get(named);
		if (block === undefined) {
			// A block this plan is going to author cannot be known yet; naming one
			// that neither exists nor is being created is a plan that cannot run.
			if (intent === undefined)
				issues.push(
					`route step ${step.id} names block ${named}, which is neither approved nor a draft of this run`,
				);
			continue;
		}
		if (apps !== undefined && !apps.has(block.app))
			issues.push(
				`route step ${step.id} names block ${named} for application ${block.app}, which the pinned stage does not declare`,
			);
		if (block.effects.includes("destructive"))
			issues.push(
				`route step ${step.id} names block ${named}, which declares a destructive effect; destructive blocks are never runnable`,
			);
		const writes =
			block.effects.includes("write") || block.effects.includes("destructive");
		if (writes && !input.plan.createsData && step.noBlockReason === undefined)
			issues.push(
				`route step ${step.id} names write block ${named}, but the plan declares createsData: false; a write block is data creation and needs the plan's approval`,
			);
		if (
			step.role !== undefined &&
			block.roles.length > 0 &&
			!block.roles.includes(step.role)
		)
			issues.push(
				`route step ${step.id} names block ${named} for route step role ${step.role}, but the block is approved for ${block.roles.join(", ")}`,
			);
	}
	return issues;
}

/** One draft of the run, as the report gate needs it: its identity and the
 * proofs recorded for it. The proof carries the version and digest it was
 * recorded *for*, so a claim can only be accepted for the document that ran. */
export interface StageBlockDraftFacts {
	readonly id: string;
	readonly version: string;
	readonly digest: string;
	readonly proofs: readonly StageBlockProofFacts[];
}

/** The cross-record checks the engine-rendered report must satisfy before a
 * byte of it is written: every declared application has one version status,
 * every cited evidence id and journal step exists, every knowledge observation
 * is one the journal recorded, and no draft carries a configured secret. The
 * render effect throws the first issue as a permanent failure; the pure list
 * keeps them testable without a stage, a browser, or an evidence root. */
export function stageReportIssues(input: {
	plan: StageTestPlan;
	report: StageTestReport;
	journal: readonly {
		seq: number;
		knowledge?: { concept: string; kind: string };
	}[];
	evidenceIds: readonly string[];
	declaredApps: readonly string[];
	secrets?: readonly string[];
	stageBlockDrafts?: readonly StageBlockDraftFacts[];
	/** The blocks the plan resolved when it was accepted, with the version of each
	 * (`USAB-121`): the report's `blocksUsed` version is checked against it. */
	stagePlanBlocks?: readonly {
		readonly routeStepId: string;
		readonly version?: string;
	}[];
}): string[] {
	const issues: string[] = [];
	if (
		input.report.applicationVersions.length !== input.declaredApps.length ||
		new Set(input.report.applicationVersions.map((item) => item.application))
			.size !== input.declaredApps.length ||
		input.report.applicationVersions.some(
			(item) => !input.declaredApps.includes(item.application),
		)
	)
		issues.push(
			"stage report must include one version status for every declared application",
		);
	const evidenceIds = new Set(input.evidenceIds);
	const stepIds = new Set(input.journal.map(({ seq }) => String(seq)));
	for (const item of input.report.expectations) {
		if (item.evidenceIds.some((id) => !evidenceIds.has(id)))
			issues.push(
				`stage report expectation ${item.id} cites evidence that is not attached to this workflow`,
			);
		if (item.stepIds.some((id) => !stepIds.has(id)))
			issues.push(
				`stage report expectation ${item.id} cites a stage journal step that does not exist`,
			);
	}
	for (const observation of input.report.knowledgeObservations)
		if (
			!input.journal.some(
				(entry) =>
					entry.knowledge?.concept === observation.concept &&
					entry.knowledge.kind === observation.kind,
			)
		)
			issues.push(
				`stage report knowledge observation ${observation.concept} is not supported by the stage journal`,
			);
	const structured = JSON.stringify({
		plan: input.plan,
		report: input.report,
	});
	if (input.secrets?.some((secret) => structured.includes(secret)))
		issues.push(
			"stage report contains a configured secret; remove it and retry without including credential values",
		);
	issues.push(
		...stageReportBlockIssues({
			plan: input.plan,
			report: input.report,
			...(input.stageBlockDrafts === undefined
				? {}
				: { stageBlockDrafts: input.stageBlockDrafts }),
			...(input.stagePlanBlocks === undefined
				? {}
				: { planBlocks: input.stagePlanBlocks }),
		}),
	);
	return issues;
}

function validReport(
	report: StageTestReport,
	plan: StageTestPlan,
	stage: {
		readonly journal?: readonly {
			seq: number;
			knowledge?: { concept: string; kind: string };
		}[];
		readonly apps?: readonly string[];
		readonly evidenceIds?: readonly string[];
		readonly blockDrafts?: readonly StageBlockDraftFacts[];
		/** The blocks the plan resolved when it was accepted, with the version the
		 * developer approved (`USAB-121`). */
		readonly planBlocks?: readonly {
			readonly routeStepId: string;
			readonly version?: string;
		}[];
	} = {},
): void {
	const expectedIds = new Set(plan.expectations.map(({ id }) => id));
	// The count and the membership, not distinct ids: the report schema owns
	// uniqueness (`stageTestReport.parse` refuses a repeated id before this guard
	// runs), so a duplicate id can only reach here from a report that was never
	// parsed, and the count covers the missing verdict that matters.
	if (
		report.expectations.length !== expectedIds.size ||
		report.expectations.some(({ id }) => !expectedIds.has(id))
	)
		throw new WorkflowRuntimeError(
			"entry-guard",
			"stage report must contain exactly one verdict for every planned expectation",
		);
	// Step-specific rules stay here; the cross-record rules (attached evidence,
	// journal steps, knowledge observations, application versions) are the same
	// ones the render effect applies, so one helper owns them instead of two
	// validators drifting apart (QUAL-005).
	for (const item of report.expectations) {
		if (
			(item.verdict === "pass" || item.verdict === "fail") &&
			item.evidenceIds.length === 0
		)
			throw new WorkflowRuntimeError(
				"entry-guard",
				`${item.verdict} verdict ${item.id} must cite evidence`,
			);
		if (item.verdict === "fail" && !item.severity)
			throw new WorkflowRuntimeError(
				"entry-guard",
				`failed expectation ${item.id} must include severity`,
			);
		if (item.stepIds.some((id) => !/^\d{1,8}$/.test(id)))
			throw new WorkflowRuntimeError(
				"entry-guard",
				`expectation ${item.id} contains an invalid stage step id`,
			);
	}
	if (
		stage.journal !== undefined &&
		stage.apps !== undefined &&
		stage.evidenceIds !== undefined
	) {
		const issue = stageReportIssues({
			plan,
			report,
			journal: stage.journal,
			evidenceIds: stage.evidenceIds,
			declaredApps: stage.apps,
			...(stage.blockDrafts === undefined
				? {}
				: { stageBlockDrafts: stage.blockDrafts }),
			...(stage.planBlocks === undefined
				? {}
				: { stagePlanBlocks: stage.planBlocks }),
		})[0];
		if (issue) throw new WorkflowRuntimeError("entry-guard", issue);
		return;
	}
	// A handoff without the stage catalog still checks the journal it does have.
	const stepIds = new Set((stage.journal ?? []).map(({ seq }) => String(seq)));
	for (const item of report.expectations)
		if (
			stage.journal !== undefined &&
			item.stepIds.some((id) => !stepIds.has(id))
		)
			throw new WorkflowRuntimeError(
				"entry-guard",
				`expectation ${item.id} cites a stage journal step that does not exist`,
			);
	for (const observation of stage.journal === undefined
		? []
		: report.knowledgeObservations)
		if (
			!stage.journal?.some(
				(entry) =>
					entry.knowledge?.concept === observation.concept &&
					entry.knowledge.kind === observation.kind,
			)
		)
			throw new WorkflowRuntimeError(
				"entry-guard",
				`knowledge observation ${observation.concept} is not supported by the stage journal`,
			);
	const apps = stage.apps;
	if (
		apps !== undefined &&
		apps.length > 0 &&
		(report.applicationVersions.length !== apps.length ||
			new Set(report.applicationVersions.map((item) => item.application))
				.size !== apps.length ||
			report.applicationVersions.some(
				(item) => !apps.includes(item.application),
			))
	)
		throw new WorkflowRuntimeError(
			"entry-guard",
			"stage report must include one version status for every declared application",
		);
}

/** The block claims a report makes, checked against the approved plan and the
 * run's own drafts (`author-stage-blocks-as-data`). A report may only claim a
 * block the plan named for that route step, a created or adjusted block needs a
 * passed proof in this run, and a route step that ended without a block has to
 * say so. Pure: the drafts and their proofs are supplied, never read here. */
export function stageReportBlockIssues(input: {
	plan: StageTestPlan;
	report: StageTestReport;
	stageBlockDrafts?: readonly StageBlockDraftFacts[];
	/** The blocks the plan resolved when it was accepted, keyed by route step,
	 * carrying the version the developer approved (`USAB-121`). */
	planBlocks?: readonly {
		readonly routeStepId: string;
		readonly version?: string;
	}[];
}): string[] {
	const issues: string[] = [];
	const route = new Map(input.plan.route.map((step) => [step.id, step]));
	const used = new Set<string>();
	const drafts = new Map(
		(input.stageBlockDrafts ?? []).map((draft) => [draft.id, draft]),
	);
	for (const claim of input.report.blocksUsed) {
		const step = route.get(claim.routeStepId);
		if (step === undefined) {
			issues.push(
				`stage report names block ${claim.block} for route step ${claim.routeStepId}, which the plan does not contain`,
			);
			continue;
		}
		used.add(claim.routeStepId);
		const named =
			step.block?.id ?? step.blockToCreate?.id ?? step.blockToAdjust?.id;
		if (named === undefined)
			issues.push(
				`stage report claims block ${claim.block} on route step ${claim.routeStepId}, which the plan plans as an exploratory step`,
			);
		else if (named !== claim.block)
			issues.push(
				`stage report claims block ${claim.block} on route step ${claim.routeStepId}, but the plan names ${named}`,
			);
		// The claim names the *document* that ran, not only its id: the review
		// prints this version to the developer as the document the run executed, so
		// a transcription that matches neither the block the plan resolved nor this
		// run's draft of it is refused (`USAB-121`).
		else {
			const draft = drafts.get(claim.block);
			const planVersion = input.planBlocks?.find(
				(block) => block.routeStepId === claim.routeStepId,
			)?.version;
			const acceptable = new Set(
				[draft?.version, planVersion].filter(
					(version): version is string => version !== undefined,
				),
			);
			if (acceptable.size > 0 && !acceptable.has(claim.version)) {
				const resolved: string[] = [];
				if (planVersion !== undefined)
					resolved.push(`the plan resolved ${claim.block}@${planVersion}`);
				if (draft !== undefined)
					resolved.push(
						`this run's draft of it is ${claim.block}@${draft.version}`,
					);
				issues.push(
					`stage report claims block ${claim.block}@${claim.version} on route step ${claim.routeStepId}, but ${resolved.join(" and ")}; cite the version that ran`,
				);
			}
		}
	}
	const unblocked = new Map(
		input.report.unblockedSteps.map((step) => [
			step.routeStepId,
			step.reason.trim(),
		]),
	);
	// A blank reason says nothing, so the step is still unaccounted for
	// (`OSV-008`).
	for (const [routeStepId, reason] of unblocked)
		if (reason === "")
			issues.push(
				`stage report lists route step ${routeStepId} as unblocked without a reason; say why this step runs without a block`,
			);
	for (const routeStepId of unblocked.keys())
		if (!route.has(routeStepId))
			issues.push(
				`stage report lists route step ${routeStepId} as unblocked, which the plan does not contain`,
			);
	for (const [kind, claims] of [
		["created", input.report.blocksCreated],
		["adjusted", input.report.blocksAdjusted],
	] as const)
		for (const claim of claims) {
			const draft = drafts.get(claim.block);
			if (draft === undefined) {
				issues.push(
					`stage report claims block ${claim.block} as ${kind}, but this run holds no draft of it`,
				);
				continue;
			}
			if (draft.version !== claim.version)
				issues.push(
					`stage report claims block ${claim.block}@${claim.version} as ${kind}, but the draft is ${draft.version}`,
				);
			// The claim names the document, not only its id and version: a
			// same-version re-save replaces the body, so a claim whose digest differs
			// is a claim about a block that no longer exists (`SEC-005`).
			else if (claim.digest !== draft.digest)
				issues.push(
					`stage report claims block ${claim.block}@${claim.version} as ${kind} with digest ${claim.digest}, but the draft the run holds is ${draft.digest}; cite the digest stage_block_save returned`,
				);
			if (
				!draft.proofs.some((proof) =>
					proofProvesBlock(proof, draft.version, draft.digest),
				)
			) {
				// Name the document and the remedy: the rule is a proof of the version
				// *and* the digest, and the stored proofs are what tell a same-version
				// re-save from an evicted proof (`USAB-122`).
				const recorded =
					draft.proofs.length === 0
						? "none"
						: draft.proofs
								.map(
									(proof) =>
										`${proof.status}@${proof.version}/${proof.digest.slice(0, 8)}`,
								)
								.join(", ");
				issues.push(
					`stage report claims block ${claim.block} as ${kind} without a passed proof of the document this run holds (${draft.version}, digest ${draft.digest}); recorded proofs: ${recorded} — run the current document once with stage_run and cite the version and digest stage_block_save returned`,
				);
			}
			const routeStepId = claim.routeStepId;
			if (routeStepId === undefined) continue;
			const step = route.get(routeStepId);
			const named =
				kind === "created" ? step?.blockToCreate?.id : step?.blockToAdjust?.id;
			if (step === undefined)
				issues.push(
					`stage report claims block ${claim.block} for route step ${routeStepId}, which the plan does not contain`,
				);
			else if (named !== claim.block)
				issues.push(
					`stage report claims block ${claim.block} as ${kind} on route step ${routeStepId}, but the plan names ${named ?? "no such block"}`,
				);
		}
	for (const step of input.plan.route) {
		if (used.has(step.id) || unblocked.has(step.id)) continue;
		// A step that names a block and is absent from both lists is a gap the
		// report has to explain, exactly like a planned exploratory step.
		issues.push(
			`stage report does not account for route step ${step.id}; name it in blocksUsed or in unblockedSteps with a reason`,
		);
	}
	return issues;
}

const planActions = ({
	stageReplayEligible,
}: {
	snapshot: WorkflowSnapshot;
	stageReplayEligible?: boolean;
}): WorkflowActionView[] => [
	...(stageReplayEligible === true
		? [
				{
					id: "approve-and-replay",
					label: "Approve plan and run compiled flow",
					confirmation: "confirm",
					requiresInput: true,
				} as const,
			]
		: [
				{
					id: "approve-plan",
					label: "Approve plan",
					confirmation: "confirm",
					requiresInput: true,
				} as const,
			]),
	{
		id: "review-comments",
		label: "Request plan changes",
		confirmation: "confirm",
		input: { schemaId: "core.review-comments", schemaVersion: 1 },
		requiresInput: true,
	},
];

type StageReplayEvidence = NonNullable<
	AgentCompletionContext["stageReplayEvidence"]
>;

function replaySummary(
	flowId: string,
	evidence: StageReplayEvidence,
	status: "passed" | "failed" | "ineligible",
	reason?: string,
): NonNullable<WorkflowSnapshot["metadata"]["stageReplay"]> {
	const result = evidence.result;
	const blockVersions: Record<string, string> = {};
	for (const step of result?.steps ?? [])
		if (typeof step.block === "string" && typeof step.version === "string")
			blockVersions[step.block] = step.version;
	return {
		status,
		flowId,
		...(typeof result?.planId === "string" ? { planId: result.planId } : {}),
		...(typeof result?.revision === "number"
			? { revision: result.revision }
			: {}),
		...(typeof result?.inputsHash === "string"
			? { inputsHash: result.inputsHash }
			: {}),
		...(typeof result?.routeHash === "string"
			? { routeHash: result.routeHash }
			: {}),
		...(Object.keys(blockVersions).length === 0 ? {} : { blockVersions }),
		...(evidence.blockDigests === undefined
			? {}
			: { blockDigests: evidence.blockDigests as Record<string, string> }),
		...(evidence.resultEvidenceId === undefined
			? {}
			: { resultEvidenceId: evidence.resultEvidenceId }),
		...(evidence.reportEvidenceId === undefined
			? {}
			: { reportEvidenceId: evidence.reportEvidenceId }),
		...(evidence.healEvidenceId === undefined
			? {}
			: { healEvidenceId: evidence.healEvidenceId }),
		...(reason === undefined ? {} : { reason }),
		...(Array.isArray(result?.steps) ? { stepCount: result.steps.length } : {}),
	};
}

/** Shared by `stage.execute` and a passing `stage.replay`: both hand a report
 * to the one render effect. */
function reportRenderCompletion(
	snapshot: WorkflowSnapshot,
	effect: { readonly kind: string; readonly data?: unknown },
) {
	if (effect.kind !== "stage.report.render") return undefined;
	const data = effect.data as
		| {
				plan?: unknown;
				report?: unknown;
				markdown?: unknown;
				reportPath?: unknown;
		  }
		| undefined;
	const plan = stageTestPlan.parse(data?.plan);
	const report = stageTestReport.parse(data?.report);
	return {
		metadata: {
			stageTestPlan: plan as unknown as JsonValue,
			stageTestReport: report as unknown as JsonValue,
			...(typeof data?.markdown === "string"
				? { stageTestReportMarkdown: data.markdown }
				: {}),
			...(snapshot.metadata.stageReplay === undefined
				? {}
				: {
						stageReplay: snapshot.metadata.stageReplay as unknown as JsonValue,
					}),
		},
		transition: {
			outcome: "complete",
			output: report as unknown as JsonValue,
		},
	};
}

const reportActions = ({
	snapshot,
}: {
	snapshot: import("../../contracts/workflow.ts").WorkflowSnapshot;
}): WorkflowActionView[] => {
	// The stored report is unparsed metadata, so every list is read defensively:
	// a run pinned to a definition older than these fields has neither.
	const report = snapshot.metadata.stageTestReport as
		| Partial<StageTestReport>
		| undefined;
	const hasKnowledge =
		report?.knowledgeObservations?.some(({ kind }) => kind !== "confirmed") ??
		false;
	// The label names how many *documents* the approval writes, so it counts the
	// ids the promotion collapses the claims to rather than the claims: one block
	// claimed by two route steps is one file (`USAB-112`).
	const authored = new Set(
		[...(report?.blocksCreated ?? []), ...(report?.blocksAdjusted ?? [])].map(
			(claim) => claim.block,
		),
	).size;
	const promote =
		authored === 0
			? ""
			: ` (promotes ${authored} block${authored === 1 ? "" : "s"})`;
	return [
		{
			id: "approve-review",
			label: `Approve report${promote}`,
			confirmation: "confirm",
		},
		...(hasKnowledge
			? [
					{
						id: "approve-and-update-wiki",
						label: `Approve and update wiki${promote}`,
						confirmation: "confirm",
					} as const,
				]
			: []),
		{
			id: "review-comments",
			label: "Request follow-up",
			confirmation: "confirm",
			input: { schemaId: "core.review-comments", schemaVersion: 1 },
			requiresInput: true,
		},
	];
};

export const stageTestBehaviors: Readonly<Record<string, StepBehavior>> = {
	"stage.plan": {
		classification: "single",
		// The stage briefs carry their own stage-bound tool rules; the generic
		// environment and browser guidance contradicts them.
		protocolSections: () => [],
		roles: () => [STAGE_TEST_PLANNER_ROLE],
		candidateRoles: () => [STAGE_TEST_PLANNER_ROLE],
		// The stage tools authorise a call by the step's selected role; a stage
		// step has no triage to choose one, so arriving selects its only role.
		onArrive: () => ({ selectedRoles: [STAGE_TEST_PLANNER_ROLE] }),
		instructionAssetForRole: () => "stage-test-plan.md",
		acceptsCommentsContext: true,
		onAgentComplete: ({
			snapshot,
			outcome,
			output,
			stageApps,
			stageBlockFacts,
		}) => {
			if (outcome !== "complete") return undefined;
			const plan = stageTestPlan.parse(output);
			const decisions = stagePlanDecisionIssues(plan);
			if (decisions.length > 0)
				throw new WorkflowRuntimeError("entry-guard", decisions[0] ?? "");
			// The stage policy applies to the block a plan names, not only to the
			// block a run finally executes (`OSV-013`).
			const [blockIssue] = stagePlanBlockIssues({
				plan,
				...(stageBlockFacts === undefined ? {} : { blocks: stageBlockFacts }),
				...(stageApps === undefined ? {} : { stageApps }),
			});
			if (blockIssue !== undefined)
				throw new WorkflowRuntimeError("entry-guard", blockIssue);
			if (plan.createsData && snapshot.metadata.stageAccess !== "writable")
				throw new WorkflowRuntimeError(
					"entry-guard",
					"a plan may create data only on a writable stage",
				);
			const requiresApproval =
				plan.flowId !== undefined ||
				snapshot.metadata.stagePlanApproval === "always" ||
				(snapshot.metadata.stagePlanApproval === "when-writing" &&
					snapshot.metadata.stageAccess === "writable" &&
					plan.createsData);
			return {
				metadata: {
					stageTestPlan: plan as unknown as JsonValue,
					// What each named block is, so the developer approves the effect set
					// and title rather than an id (`OSV-014`).
					...(stageBlockFacts === undefined
						? {}
						: {
								stagePlanBlocks: plan.route.flatMap((step) => {
									const named = step.block?.id ?? step.blockToAdjust?.id;
									const block = stageBlockFacts.find(
										(fact) => fact.id === named,
									);
									return named === undefined
										? []
										: [
												{
													routeStepId: step.id,
													id: named,
													...(block === undefined
														? {}
														: {
																version: block.version,
																title: block.title,
																app: block.app,
																effects: [...block.effects],
																roles: [...block.roles],
															}),
												},
											];
								}) as unknown as JsonValue,
							}),
				},
				transition: {
					outcome: requiresApproval ? "needs-approval" : "execute",
				},
			};
		},
		assignmentInputs: ({ snapshot }) => ({
			objective: `Plan a verification of pinned stage ${snapshot.metadata.stage} for: ${snapshot.metadata.task ?? snapshot.metadata.ticket ?? "the requested workflow"}.`,
			introLines: [
				`Pinned stage: ${snapshot.metadata.stage}; system: ${snapshot.metadata.stageSystem}; access: ${snapshot.metadata.stageAccess}; plan approval policy: ${snapshot.metadata.stagePlanApproval}.`,
				`Stage process knowledge hints: ${JSON.stringify(snapshot.metadata.stageWikiProcesses ?? [])}`,
				"Use stage_info and the declared applications/roles; resolve matching process knowledge from the pinned system namespace before planning. Do not browse, log in, or issue requests while planning.",
				"The plan must cover each ticket expectation, explicitly state whether process knowledge was found, identify trust/staleness for each concept used, and say whether data will be created; bound all async waits.",
			],
			permissions: [
				"inspect the pinned stage catalog",
				"write a structured plan",
			],
			checks: [
				"every route uses a declared application",
				"no planned action mutates application state unless the stage is writable and plan approval is required",
			],
		}),
	},
	"stage.plan-review": {
		developerActions: planActions,
	},
	"stage.execute": {
		classification: "single",
		protocolSections: () => [],
		roles: () => [STAGE_TESTER_ROLE],
		candidateRoles: () => [STAGE_TESTER_ROLE],
		onArrive: () => ({ selectedRoles: [STAGE_TESTER_ROLE] }),
		instructionAssetForRole: () => "stage-test-execute.md",
		acceptsCommentsContext: true,
		onAgentComplete: ({
			snapshot,
			outcome,
			output,
			stageJournal,
			stageApps,
			stageEvidenceIds,
			stageBlockDrafts,
		}) => {
			if (outcome !== "complete") return undefined;
			const plan = planFor(snapshot.metadata.stageTestPlan);
			const report = stageTestReport.parse(output);
			validReport(report, plan, {
				...(stageJournal === undefined ? {} : { journal: stageJournal }),
				...(stageApps === undefined ? {} : { apps: stageApps }),
				...(stageEvidenceIds === undefined
					? {}
					: { evidenceIds: stageEvidenceIds }),
				...(stageBlockDrafts === undefined
					? {}
					: { blockDrafts: stageBlockDrafts }),
				...(snapshot.metadata.stagePlanBlocks === undefined
					? {}
					: { planBlocks: snapshot.metadata.stagePlanBlocks }),
			});
			return {
				deferTransition: true,
				effects: [
					{
						kind: "stage.report.render",
						idempotencyKey: `stage-report:${snapshot.workflowId}:${snapshot.revision}`,
						payload: {
							plan: plan as unknown as JsonValue,
							report: report as unknown as JsonValue,
						},
					},
				],
			};
		},
		onEffectComplete: ({ snapshot, effect }) =>
			reportRenderCompletion(snapshot, effect),
		assignmentInputs: ({ snapshot }) => ({
			objective: `Execute the approved plan against pinned stage ${snapshot.metadata.stage}.`,
			introLines: [
				`Pinned stage: ${snapshot.metadata.stage}; access: ${snapshot.metadata.stageAccess}.`,
				`Approved plan: ${JSON.stringify(snapshot.metadata.stageTestPlan ?? {})}`,
				"Use only the approved route: for a UI app open browser_open({stage: <exact pinned ident>, stageApp: <declared app>}); for an API app use stage_api_request with the pinned stage and declared role. Raw URLs and app endpoints are forbidden.",
				"Never issue an unplanned state-changing action. A planned create is allowed only on a writable stage and after any approval required by the pinned plan policy; never delete or mutate data outside the approved route.",
				"Record meaningful actions with stage_step, cite attached evidence ids, and use stage_wait for bounded asynchronous waits.",
				"A blocked scenario is still a complete report: return blocked verdicts for inaccessible stage/login cases rather than a blocked run outcome.",
				"Report exactly one version entry per declared app: status available with version, or unavailable with a concise reason.",
				"Return one verdict per planned expectation. Pass/fail verdicts cite attached evidence; failures include severity. Do not write markdown: the engine renders the report.",
			],
			permissions: [
				"access only the pinned stage and declared apps/roles",
				"perform only the approved route",
				"record sanitized observations and evidence",
			],
			checks: [
				"every planned expectation has a verdict",
				"no unplanned state change occurs",
				"all citations refer to existing evidence and journal steps",
			],
		}),
	},
	"stage.replay": {
		classification: "single",
		protocolSections: () => [],
		roles: () => [STAGE_TESTER_ROLE],
		candidateRoles: () => [STAGE_TESTER_ROLE],
		onArrive: () => ({ selectedRoles: [STAGE_TESTER_ROLE] }),
		instructionAssetForRole: () => "stage-test-replay.md",
		onAgentComplete: ({
			snapshot,
			stageJournal,
			stageApps,
			stageEvidenceIds,
			stageBlockDrafts,
			stageReplayEvidence,
		}) => {
			const plan = planFor(snapshot.metadata.stageTestPlan);
			const flowId = plan.flowId;
			if (flowId === undefined)
				return {
					metadata: {
						stageReplay: {
							status: "ineligible",
							reason: "the plan names no flow",
						},
					},
					transition: { outcome: "fallback" },
				};
			const evidence = stageReplayEvidence ?? {};
			const status = evidence.result?.status;
			if (status === "passed") {
				try {
					const report = stageTestReport.parse(evidence.report);
					validReport(report, plan, {
						...(stageJournal === undefined ? {} : { journal: stageJournal }),
						...(stageApps === undefined ? {} : { apps: stageApps }),
						...(stageEvidenceIds === undefined
							? {}
							: { evidenceIds: stageEvidenceIds }),
						...(stageBlockDrafts === undefined
							? {}
							: { blockDrafts: stageBlockDrafts }),
					});
					return {
						metadata: {
							stageReplay: replaySummary(flowId, evidence, "passed"),
						},
						deferTransition: true,
						effects: [
							{
								kind: "stage.report.render",
								idempotencyKey: `stage-report:${snapshot.workflowId}:${snapshot.revision}`,
								payload: {
									plan: plan as unknown as JsonValue,
									report: report as unknown as JsonValue,
									step: "stage.replay",
								},
							},
						],
					};
				} catch (error) {
					return {
						metadata: {
							stageReplay: replaySummary(
								flowId,
								evidence,
								"ineligible",
								`the replay report is not usable: ${error instanceof Error ? error.message : String(error)}`,
							),
						},
						transition: { outcome: "fallback" },
					};
				}
			}
			if (status === "failed")
				return {
					metadata: {
						stageReplay: replaySummary(flowId, evidence, "failed"),
						...(evidence.heal === undefined
							? {}
							: {
									stageReplayHeal: evidence.heal as JsonValue,
								}),
					},
					transition: { outcome: "failed" },
				};
			return {
				metadata: {
					stageReplay: replaySummary(
						flowId,
						evidence,
						"ineligible",
						"the replay produced no result; the normal tester must run",
					),
				},
				transition: { outcome: "fallback" },
			};
		},
		onEffectComplete: ({ snapshot, effect }) =>
			reportRenderCompletion(snapshot, effect),
		assignmentInputs: ({ snapshot }) => ({
			objective: `Replay the approved compiled flow against pinned stage ${snapshot.metadata.stage}.`,
			introLines: [
				`Pinned stage: ${snapshot.metadata.stage}; access: ${snapshot.metadata.stageAccess}.`,
				`Approved plan: ${JSON.stringify(snapshot.metadata.stageTestPlan ?? {})}`,
				"Call stage_replay({ flowId }) exactly once. Omit inputs: the approved plan revision is the authority for every value.",
				"Do not take browser snapshots, click, fill, run scripts, edit blocks or regenerate a spec. The replay process runs the reviewed spec without a model per step.",
				"If the tool reports an ineligible flow, dry-run issues or a refusal, return the fallback outcome with the reason. If it reports a failed replay, return failed; the heal packet is attached and the normal tester runs next.",
				"Do not retry a failed replay, edit a block or spec, recompile, commit or push. Return complete after a passing replay; the engine attaches the deterministic report itself.",
			],
			permissions: [
				"run only the approved flow on the pinned stage",
				"read its result, report and heal evidence",
			],
			checks: [
				"no model-driven browser action happens in this step",
				"no repository file changes",
			],
		}),
	},
	"stage.review": {
		developerActions: reportActions,
		carriesOutputContext: true,
		acceptsCommentsContext: true,
	},
};
