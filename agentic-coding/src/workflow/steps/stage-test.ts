// The pinned-stage workflow's step behaviors. The browser server enforces the
// stage pin and stage access policy independently; these behaviors supply the
// least-privilege roles and the structured report contract. Pure domain module:
// it consumes only supplied validated evidence
// (`stageReplayEvidence`), never the evidence store or the stage-blocks
// registry itself — those reads happen at the impure boundary
// (`workflow/runtime/store.ts`, `workflow/runtime/reducers/agent-handoff.ts`).
//
// The tester is the workflow's only agent (`remove-stage-test-planner`): it
// explores the pinned stage and decides its own expectations, so `stage.execute`
// has no plan to consume and the report carries no plan accounting. The plan and
// replay behaviors stay registered for the definition tiers that still declare
// those steps — a workflow pinned to one of them keeps resolving and finishing.

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

/** The block decision of one route step, for the definition tiers that still
 * declare a plan step: exactly one of a block, a block the tester is to author,
 * a block to adjust, or a stated reason why the step cannot be a block at all.
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

/** One approved or drafted block, as the plan gate needed it. The registry is
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
 * Only the tiers that still declare a plan step call this. The plan states which
 * block each route step will run, so the stage policy has to be enforced there
 * and not only when the block is finally executed:
 *
 * - a step that names an approved block must name one the stage can run — an
 *   unknown id is a plan that cannot execute;
 * - the block's declared application must be one the pinned stage declares,
 *   exactly as a route step's own `application` must;
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

/** One block of the composed registry, as the report gate needs it. The registry
 * is read at the impure boundary and passed in, so this stays pure. */
export interface StageBlockFact {
	readonly id: string;
	readonly version: string;
}

/** The cross-record checks the engine-rendered report must satisfy before a
 * byte of it is written: every declared application has one version status,
 * every cited evidence id and journal step exists, every knowledge observation
 * is one the journal recorded, and no draft carries a configured secret. The
 * render effect throws the first issue as a permanent failure; the pure list
 * keeps them testable without a stage, a browser, or an evidence root. */
export function stageReportIssues(input: {
	report: StageTestReport;
	journal: readonly {
		seq: number;
		knowledge?: { concept: string; kind: string };
	}[];
	evidenceIds: readonly string[];
	declaredApps: readonly string[];
	secrets?: readonly string[];
	stageBlockDrafts?: readonly StageBlockDraftFacts[];
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
	const structured = JSON.stringify(input.report);
	if (input.secrets?.some((secret) => structured.includes(secret)))
		issues.push(
			"stage report contains a configured secret; remove it and retry without including credential values",
		);
	issues.push(
		...stageReportBlockIssues({
			report: input.report,
			...(input.stageBlockDrafts === undefined
				? {}
				: { stageBlockDrafts: input.stageBlockDrafts }),
		}),
	);
	return issues;
}

function validReport(
	report: StageTestReport,
	stage: {
		readonly journal?: readonly {
			seq: number;
			knowledge?: { concept: string; kind: string };
		}[];
		readonly apps?: readonly string[];
		readonly evidenceIds?: readonly string[];
		readonly blockDrafts?: readonly StageBlockDraftFacts[];
		/** The composed registry's blocks, so a `blocksUsed` claim is checked
		 * against a block the pinned stage can actually run. */
		readonly blocks?: readonly StageBlockFact[];
	} = {},
): void {
	// Step-specific rules stay here; the cross-record rules (attached evidence,
	// journal steps, knowledge observations, application versions) are the same
	// ones the render effect applies, so one helper owns them instead of two
	// validators drifting apart (QUAL-005).
	for (const item of report.expectations) {
		// The tester writes its own expectations, so the report has to say what
		// each one checked: a verdict whose statement is blank is a verdict the
		// developer cannot read (`remove-stage-test-planner`).
		if (!item.statement?.trim())
			throw new WorkflowRuntimeError(
				"entry-guard",
				`expectation ${item.id} has no statement; state what you checked`,
			);
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
	for (const claim of report.blocksUsed) {
		const known = stage.blocks?.find((block) => block.id === claim.block);
		if (stage.blocks !== undefined && known === undefined)
			throw new WorkflowRuntimeError(
				"entry-guard",
				`stage report cites block ${claim.block}, which is not in the run's block catalog; run the block with stage_run and cite what ran`,
			);
		if (known !== undefined && known.version !== claim.version)
			throw new WorkflowRuntimeError(
				"entry-guard",
				`stage report cites block ${claim.block}@${claim.version}, but the registry holds ${known.version}; cite the version that ran`,
			);
	}
	if (
		stage.journal !== undefined &&
		stage.apps !== undefined &&
		stage.evidenceIds !== undefined
	) {
		const issue = stageReportIssues({
			report,
			journal: stage.journal,
			evidenceIds: stage.evidenceIds,
			declaredApps: stage.apps,
			...(stage.blockDrafts === undefined
				? {}
				: { stageBlockDrafts: stage.blockDrafts }),
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

/** The block claims a report makes, checked against the run's own drafts
 * (`author-stage-blocks-as-data`). A created or adjusted block needs a passed
 * proof of the document this run holds; a claim about a block without a draft is
 * a run the engine has no proof for. Pure: the drafts and their proofs are
 * supplied, never read here. */
export function stageReportBlockIssues(input: {
	report: StageTestReport;
	stageBlockDrafts?: readonly StageBlockDraftFacts[];
}): string[] {
	const issues: string[] = [];
	const drafts = new Map(
		(input.stageBlockDrafts ?? []).map((draft) => [draft.id, draft]),
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

/** The one render effect `stage.execute` completes through (and the replay step
 * of an earlier tier): the engine owns the markdown, the step owns the
 * transition. */
function reportRenderCompletion(
	snapshot: WorkflowSnapshot,
	effect: { readonly kind: string; readonly data?: unknown },
) {
	if (effect.kind !== "stage.report.render") return undefined;
	const data = effect.data as
		| { report?: unknown; markdown?: unknown; reportPath?: unknown }
		| undefined;
	const report = stageTestReport.parse(data?.report);
	return {
		metadata: {
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
	const hasKnowledge = (report?.knowledgeObservations?.length ?? 0) > 0;
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
	const confirmedOnly =
		hasKnowledge &&
		report?.knowledgeObservations?.every(
			(observation) => observation.kind === "confirmed",
		);
	const wikiLabel = confirmedOnly
		? "Approve and review wiki (no changes expected)"
		: "Approve and update wiki";
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
						label: `${wikiLabel}${promote}`,
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
	// The plan and replay steps belong to the definition tiers registered before
	// `remove-stage-test-planner`; they stay here so a workflow pinned to one of
	// them still resolves every step and finishes (see `graphs/stage-test.ts`).
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
			stageBlockFacts,
		}) => {
			if (outcome !== "complete") return undefined;
			const report = stageTestReport.parse(output);
			validReport(report, {
				...(stageJournal === undefined ? {} : { journal: stageJournal }),
				...(stageApps === undefined ? {} : { apps: stageApps }),
				...(stageEvidenceIds === undefined
					? {}
					: { evidenceIds: stageEvidenceIds }),
				...(stageBlockDrafts === undefined
					? {}
					: { blockDrafts: stageBlockDrafts }),
				...(stageBlockFacts === undefined ? {} : { blocks: stageBlockFacts }),
			});
			return {
				deferTransition: true,
				effects: [
					{
						kind: "stage.report.render",
						idempotencyKey: `stage-report:${snapshot.workflowId}:${snapshot.revision}`,
						payload: {
							report: report as unknown as JsonValue,
						},
					},
				],
			};
		},
		onEffectComplete: ({ snapshot, effect }) =>
			reportRenderCompletion(snapshot, effect),
		assignmentInputs: ({ snapshot }) => ({
			objective: `Test pinned stage ${snapshot.metadata.stage} against: ${snapshot.metadata.task ?? snapshot.metadata.ticket ?? "the requested workflow"}.`,
			introLines: [
				`Pinned stage: ${snapshot.metadata.stage}; system: ${snapshot.metadata.stageSystem}; access: ${snapshot.metadata.stageAccess}.`,
				"You own the whole test: read the process knowledge for the pinned system, decide what to check, then explore the stage and test against it. There is no plan to approve and no separate planning step.",
				"For a UI application open browser_open({stage: <exact pinned ident>, stageApp: <declared app>}); for an API application use stage_api_request with the pinned stage and a declared role. Raw URLs, other origins and apps the stage does not declare are refused.",
				"Use the reviewed blocks when one fits, and author or adjust a block with stage_block_save when a flow is worth keeping; run blocks with stage_run. A saved flow can be replayed with stage_replay. Nothing is required to be a block: explore freely when that is the faster way to the truth.",
				"When a step fails, inspect the feedback and try a materially different approach — improvise interaction techniques and equivalent paths, another locator or an offered catalog choice — before deciding it is blocked. Preserve explicit developer constraints, the declared apps and roles, and the stage's access; do not bypass product validation or edit evidence to satisfy a guard.",
				"This is a test stage: on a writable stage you may create and change test data as you need, including data you did not anticipate; never delete or edit pre-existing or foreign records, and list everything you created.",
				"Record meaningful actions with stage_step, cite attached evidence ids, and use stage_wait for bounded asynchronous waits.",
				"A blocked scenario is still a complete report: return blocked verdicts for inaccessible stage/login cases rather than a blocked run outcome.",
				"Report exactly one version entry per declared app: status available with version, or unavailable with a concise reason.",
				"Return one expectation per thing you checked: a statement of what you checked, expected and observed, a verdict, and the journal steps and evidence ids it rests on. Pass and fail verdicts cite evidence; failures include severity; a fail must be reproducible from what you write. Say in notTested what you deliberately did not test. Do not write markdown: the engine renders the report.",
			],
			permissions: [
				"access only the pinned stage and declared apps/roles",
				"create and change test data on a writable stage",
				"record sanitized observations and evidence",
			],
			checks: [
				"every verdict cites existing evidence and journal steps",
				"no pre-existing or foreign record is deleted or edited",
				"the report says what was not tested",
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
					validReport(report, {
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
