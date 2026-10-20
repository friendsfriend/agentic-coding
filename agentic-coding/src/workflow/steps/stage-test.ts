// The pinned-stage workflow's two agent steps. The browser server enforces the
// stage pin and stage access policy independently; these behaviors supply the
// least-privilege roles and the structured plan/report contracts.
import type {
	JsonValue,
	WorkflowActionView,
} from "../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import {
	type StageTestPlan,
	type StageTestReport,
	stageTestPlan,
	stageTestReport,
} from "../definitions/contracts.ts";
import type { StepBehavior } from "./types.ts";

export const STAGE_TEST_PLANNER_ROLE = "stage-planner";
export const STAGE_TESTER_ROLE = "stage-tester";
export const STAGE_TEST_WIKI_ROLE = "stage-wiki";

const planFor = (value: JsonValue | undefined): StageTestPlan =>
	stageTestPlan.parse(value);

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
	return issues;
}

function validReport(
	report: StageTestReport,
	plan: StageTestPlan,
	_stageEvidence: readonly { kind: string; path: string; digest: string }[],
	stageJournal?: readonly {
		seq: number;
		knowledge?: { concept: string; kind: string };
	}[],
	stageApps?: readonly string[],
	stageEvidenceIds?: readonly string[],
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
		stageJournal !== undefined &&
		stageApps !== undefined &&
		stageEvidenceIds !== undefined
	) {
		const issue = stageReportIssues({
			plan,
			report,
			journal: stageJournal,
			evidenceIds: stageEvidenceIds,
			declaredApps: stageApps,
		})[0];
		if (issue) throw new WorkflowRuntimeError("entry-guard", issue);
		return;
	}
	// A handoff without the stage catalog still checks the journal it does have.
	const stepIds = new Set((stageJournal ?? []).map(({ seq }) => String(seq)));
	for (const item of report.expectations)
		if (
			stageJournal !== undefined &&
			item.stepIds.some((id) => !stepIds.has(id))
		)
			throw new WorkflowRuntimeError(
				"entry-guard",
				`expectation ${item.id} cites a stage journal step that does not exist`,
			);
	for (const observation of stageJournal === undefined
		? []
		: report.knowledgeObservations)
		if (
			!stageJournal?.some(
				(entry) =>
					entry.knowledge?.concept === observation.concept &&
					entry.knowledge.kind === observation.kind,
			)
		)
			throw new WorkflowRuntimeError(
				"entry-guard",
				`knowledge observation ${observation.concept} is not supported by the stage journal`,
			);
	if (
		stageApps !== undefined &&
		stageApps.length > 0 &&
		(report.applicationVersions.length !== stageApps.length ||
			new Set(report.applicationVersions.map((item) => item.application))
				.size !== stageApps.length ||
			report.applicationVersions.some(
				(item) => !stageApps.includes(item.application),
			))
	)
		throw new WorkflowRuntimeError(
			"entry-guard",
			"stage report must include one version status for every declared application",
		);
}

const planActions = (): WorkflowActionView[] => [
	{
		id: "approve-plan",
		label: "Approve plan",
		confirmation: "confirm",
		requiresInput: true,
	},
	{
		id: "review-comments",
		label: "Request plan changes",
		confirmation: "confirm",
		input: { schemaId: "core.review-comments", schemaVersion: 1 },
		requiresInput: true,
	},
];

const reportActions = ({
	snapshot,
}: {
	snapshot: import("../../contracts/workflow.ts").WorkflowSnapshot;
}): WorkflowActionView[] => {
	const report = snapshot.metadata.stageTestReport as
		| StageTestReport
		| undefined;
	const hasKnowledge =
		report?.knowledgeObservations.some(({ kind }) => kind !== "confirmed") ??
		false;
	return [
		{ id: "approve-review", label: "Approve report", confirmation: "confirm" },
		...(hasKnowledge
			? [
					{
						id: "approve-and-update-wiki",
						label: "Approve and update wiki",
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
		roles: () => [STAGE_TEST_PLANNER_ROLE],
		candidateRoles: () => [STAGE_TEST_PLANNER_ROLE],
		instructionAssetForRole: () => "stage-test-plan.md",
		acceptsCommentsContext: true,
		onAgentComplete: ({ snapshot, outcome, output }) => {
			if (outcome !== "complete") return undefined;
			const plan = stageTestPlan.parse(output);
			if (plan.createsData && snapshot.metadata.stageAccess !== "writable")
				throw new WorkflowRuntimeError(
					"entry-guard",
					"a plan may create data only on a writable stage",
				);
			const requiresApproval =
				snapshot.metadata.stagePlanApproval === "always" ||
				(snapshot.metadata.stagePlanApproval === "when-writing" &&
					snapshot.metadata.stageAccess === "writable" &&
					plan.createsData);
			return {
				metadata: { stageTestPlan: plan as unknown as JsonValue },
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
		roles: () => [STAGE_TESTER_ROLE],
		candidateRoles: () => [STAGE_TESTER_ROLE],
		instructionAssetForRole: () => "stage-test-execute.md",
		acceptsCommentsContext: true,
		onAgentComplete: ({
			snapshot,
			outcome,
			output,
			stageJournal,
			stageApps,
			stageEvidenceIds,
		}) => {
			if (outcome !== "complete") return undefined;
			const plan = planFor(snapshot.metadata.stageTestPlan);
			const report = stageTestReport.parse(output);
			validReport(
				report,
				plan,
				snapshot.evidence,
				stageJournal,
				stageApps,
				stageEvidenceIds,
			);
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
		onEffectComplete: ({ effect }) => {
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
					// The bounded Markdown is persisted in snapshot metadata so the
					// dashboard can show the report without an evidence round-trip. The
					// render effect truncates it to 500k characters, well inside the
					// snapshot's 2 MiB text bound; the duplicate bytes on disk and in
					// the store are the accepted cost of that convenience (PERF-001).
					...(typeof data?.markdown === "string"
						? { stageTestReportMarkdown: data.markdown }
						: {}),
				},
				transition: {
					outcome: "complete",
					output: report as unknown as JsonValue,
				},
			};
		},
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
	"stage.review": {
		developerActions: reportActions,
		carriesOutputContext: true,
		acceptsCommentsContext: true,
	},
};
