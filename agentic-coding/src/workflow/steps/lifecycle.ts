import { effectiveFamilyTraits } from "../definitions/manifest-policy.ts";
import type { WorkflowFamilyTraits } from "../registry.ts";
import type { StepBehavior } from "./types.ts";
import {
	type PreparedStepEvidence,
	validateArchiveEvidence,
} from "./validation.ts";

const REVIEW_COMMENTS_INPUT = {
	schemaId: "core.review-comments",
	schemaVersion: 1,
} as const;
/** Documentation families declare no repository traits, and their
 * `core.completed` never offers `create-pr` either: the wiki and research
 * workflows have nothing to push as a repository pull request. They are the
 * holdout list the trait read falls back to, not a repository code-change
 * family (`read-family-traits-instead-of-ids` keeps the documentation
 * families' own id checks by design). */
const DOCUMENTATION_CLOSE_ONLY = new Set(["wiki", "wiki-comments", "research"]);

/** Whether a definition's `core.completed` offers only `close`: every family
 * that delivers no pull request — the proposal-only workflows, which never
 * reach delivery, the single-agent and ref-shaped families, which have nothing
 * to push, and the documentation families. Read from the `delivery` trait
 * instead of a definition-id list; a caller that passes no traits falls back to
 * the catalog table `effectiveFamilyTraits` reads, so every built-in family
 * keeps its behavior. */
function closeOnly(
	definitionId: string,
	traits?: WorkflowFamilyTraits,
): boolean {
	const effective = traits ?? effectiveFamilyTraits({ id: definitionId });
	return effective
		? effective.delivery === "none"
		: DOCUMENTATION_CLOSE_ONLY.has(definitionId);
}

/** The review decision both review steps offer: approve the work, or send the
 * selected findings back to the worker. `core.developer-review` gates a change
 * the worker produced; `core.findings-review` is the verify-only family's entry
 * into that same worker loop, where the findings — including the critical ones
 * that already fail the round — are what the developer selects from. */
const reviewActions = () => [
	{
		id: "approve-review",
		label: "Approve change",
		confirmation: "confirm" as const,
		requiresInput: true,
	},
	{
		id: "review-comments",
		label: "Request changes",
		confirmation: "confirm" as const,
		input: REVIEW_COMMENTS_INPUT,
		requiresInput: true,
	},
];

/** The archive step's bounded repair loop (`bound-archive-repair-loop`): one
 * archive entry gets at most this many `openspec validate`/`archive` attempts —
 * the entry itself and one structural repair round — and after the last failure
 * the step hands off `blocked` instead of starting another round. */
export const ARCHIVE_ATTEMPT_LIMIT = 2;
/** The step-local counter the budget lives in (`snapshot.loopCounts`), beside
 * the verification round/fix counters. */
export const ARCHIVE_ATTEMPT_KEY = "core.archive:attempts";
/** Set by `onArrive` for an entry the engine transitioned into (the graph entry
 * or the failed attempt's own self-loop) and consumed by `onEnter`. Absent means
 * the step was entered without an arrival — a developer `operator.repair` or a
 * resumed workflow — which starts a fresh pair of attempts. */
export const ARCHIVE_ARRIVAL_KEY = "core.archive:arrival";

export const lifecycleBehaviors: Readonly<Record<string, StepBehavior>> = {
	"core.plan-approval": {
		developerActions: () => [
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
				input: REVIEW_COMMENTS_INPUT,
				requiresInput: true,
			},
			{
				id: "reject-plan",
				label: "Reject plan",
				confirmation: "reason",
				input: { schemaId: "core.plan-rejection", schemaVersion: 1 },
				requiresInput: true,
			},
		],
	},
	"core.developer-review": {
		developerActions: reviewActions,
	},
	// The verify-only family's review: identical actions and input schema, so the
	// dashboard's review popup and its `review-comments` dispatch work unchanged.
	// The difference is the findings it shows (the observation includes critical
	// findings while this step is current) and the graph edge it leaves on.
	"core.findings-review": {
		developerActions: reviewActions,
	},
	"core.wiki-approval": {
		developerActions: () => [
			{
				id: "approve-wiki",
				label: "Approve wiki",
				confirmation: "confirm",
				requiresInput: true,
			},
			{
				id: "review-comments",
				label: "Request wiki changes",
				confirmation: "confirm",
				input: REVIEW_COMMENTS_INPUT,
				requiresInput: true,
			},
		],
		producesWikiVerificationContext: true,
	},
	"core.delivery": {
		onEffectComplete: ({ snapshot, effect }) => {
			if (effect.kind === "delivery.commit")
				return {
					effects: [
						{
							kind: "delivery.push",
							idempotencyKey: `delivery:${snapshot.workflowId}:push`,
							payload: { workflowId: snapshot.workflowId },
						},
					],
				};
			if (effect.kind === "delivery.push")
				return { transition: { outcome: "complete" } };
			return undefined;
		},
		onEnter: ({ snapshot, enqueue }) => {
			enqueue("delivery.commit", `delivery:${snapshot.workflowId}:commit`, {
				workflowId: snapshot.workflowId,
			});
			return undefined;
		},
	},
	"core.completed": {
		onArrive: () => ({ status: "completed" }),
		developerActions: ({ snapshot, traits }) => [
			...(closeOnly(snapshot.definition.id, traits)
				? []
				: [
						{
							id: "create-pr",
							label: "Create pull request",
							confirmation: "confirm" as const,
						},
					]),
			{ id: "close", label: "Close workflow", confirmation: "confirm" },
		],
	},
	"core.closed": {
		onArrive: () => ({ status: "closed" }),
		onEnter: ({ snapshot, enqueue }) => {
			enqueue("workspace.close", `workspace:${snapshot.workflowId}:close`, {
				workflowId: snapshot.workflowId,
			});
			// Releasing the workflow's app slots is the owner-bound teardown: it runs
			// through the outbox so an unreachable environment server is retried
			// instead of being recorded as a release. It is enqueued here, before the
			// `workspace.cleanup` the close effect's completion queues, because the
			// stop runs from the workflow's own checkout — removing it first would
			// leave a run nobody can stop.
			enqueue(
				"environment.teardown",
				`environment:${snapshot.workflowId}:teardown`,
				{
					workflowId: snapshot.workflowId,
					owner: `workflow:${snapshot.workflowId}`,
				},
			);
			// An env-setup workflow also owns a staged configuration root: a complete
			// copy of the live configuration that must not outlive it
			// (staged-env-setup-config-root). Every other family has no such state.
			if (snapshot.definition?.id === "env-setup")
				enqueue(
					"environment.setup-cleanup",
					`environment:${snapshot.workflowId}:setup-cleanup`,
					{
						workflowId: snapshot.workflowId,
						draftsDir: snapshot.metadata.setupDraftsDir ?? "",
					},
				);
			return undefined;
		},
	},
	"core.archive": {
		classification: "single",
		roles: () => ["archive"],
		candidateRoles: () => ["archive"],
		validateEvidence: ({ evidence }) =>
			validateArchiveEvidence(evidence as PreparedStepEvidence),
		acceptsCommentsContext: true,
		// The attempt budget is step-local state read and written here: `onArrive`
		// counts an entry the engine transitioned into, `onEnter` starts a fresh
		// pair for an entry the engine did not transition into, and
		// `onAgentComplete` spends the budget on a failed attempt.
		onArrive: ({ snapshot, edge }) => {
			snapshot.loopCounts[ARCHIVE_ATTEMPT_KEY] =
				edge.from === "core.archive"
					? (snapshot.loopCounts[ARCHIVE_ATTEMPT_KEY] ?? 1) + 1
					: 1;
			snapshot.loopCounts[ARCHIVE_ARRIVAL_KEY] = 1;
			return undefined;
		},
		onEnter: ({ snapshot }) => {
			if (snapshot.loopCounts[ARCHIVE_ARRIVAL_KEY]) {
				snapshot.loopCounts[ARCHIVE_ARRIVAL_KEY] = 0;
				return undefined;
			}
			snapshot.loopCounts[ARCHIVE_ATTEMPT_KEY] = 1;
			return undefined;
		},
		onAgentComplete: ({ snapshot, outcome }) => {
			if (outcome !== "blocked") return undefined;
			const attempt = snapshot.loopCounts[ARCHIVE_ATTEMPT_KEY] ?? 1;
			// A failed attempt with budget left re-enters this step for the one
			// structural repair round, and the granted round is the decision worth
			// reporting. The last attempt returns no completion at all: the handoff's
			// own `blocked` message parks the workflow with the validator output (bounded
			// by the handoff contract's 4096-byte `message` field, which refuses an
			// oversized detail before anything is persisted), and a completion without a
			// transition would leave the workflow active with no run to finish it.
			if (attempt >= ARCHIVE_ATTEMPT_LIMIT) return undefined;
			return {
				transition: { outcome: "blocked" },
				telemetry: [
					{
						event: "archive.repair_round",
						payload: {
							"herdr.archive.failed_attempt": attempt,
							"herdr.archive.next_attempt": attempt + 1,
							"herdr.archive.limit": ARCHIVE_ATTEMPT_LIMIT,
						},
					},
				],
			};
		},
		assignmentInputs: ({ snapshot }) => {
			const attempt = Math.min(
				snapshot.loopCounts[ARCHIVE_ATTEMPT_KEY] ?? 1,
				ARCHIVE_ATTEMPT_LIMIT,
			);
			return {
				introLines: [
					`Archive attempt ${attempt} of ${ARCHIVE_ATTEMPT_LIMIT}: the engine allows at most ${ARCHIVE_ATTEMPT_LIMIT} \`openspec validate\`/\`openspec archive\` attempts for this archive entry, and this run owns attempt ${attempt}.`,
					attempt > 1
						? 'This is the structural repair attempt. Reproduce the failure with `openspec validate "$HERDR_CHANGE_ID" --strict`, fix only structural issues (missing `## MODIFIED Requirements`/`## REMOVED Requirements` sections) against the approved proposal, then run the validate/archive pair once. If the failure is not structural, hand off `blocked` with the exact validator output instead of guessing.'
						: "Run the `openspec validate`/`openspec archive` pair exactly once and do not edit the change documents on this attempt. A failure hands the exact validator output back as this attempt's blocked message — the engine grants one repair attempt, never a third.",
				],
				checks: [
					`at most one \`openspec validate "$HERDR_CHANGE_ID" --strict\` plus one \`openspec archive "$HERDR_CHANGE_ID" --yes\` for attempt ${attempt} of ${ARCHIVE_ATTEMPT_LIMIT}`,
				],
			};
		},
		handoffNote: [
			"Finish the archive attempt with one outcome and the command output it produced:",
			"Hand off `complete` only for an archived change (the engine verifies the archive move itself).",
			"Hand off `blocked` with the failing validator output verbatim: that message is the developer's whole repair brief. The handoff command refuses a message over 4096 bytes, so hand over at most 4000 characters of the output rather than the whole transcript.",
		],
	},
};
