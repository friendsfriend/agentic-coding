// The `env-setup` family's step behaviors (add-environment-setup-workflow).
//
// The family is four steps: an agent authors drafts, the system validates them
// by running them, the developer approves a diff, and the system promotes the
// drafts into the live configuration. Every side effect is a durable effect the
// runtime owns — the write guard, the validation run and the promotion — so a
// step never does I/O itself and a crashed round resumes from its effect.
import type { JsonValue } from "../../contracts/workflow.ts";
import type { StepBehavior } from "./types.ts";

export const ENV_SETUP_ROLE = "env-setup";
export const ENV_SETUP_APPROVE_ACTION = "approve-setup";
export const ENV_SETUP_REVIEW_ACTION = "review-comments";
export const ENV_SETUP_ROLLBACK_ACTION = "rollback-promotion";
export const ENV_SETUP_ACCEPT_SMOKE_ACTION = "accept-smoke-failure";
export const GUARD_EFFECT = "environment.setup-guard";
export const STAGE_EFFECT = "environment.setup-stage";
export const VALIDATE_EFFECT = "environment.validate";
export const PROMOTE_EFFECT = "environment.promote";
export const SMOKE_EFFECT = "environment.setup-smoke";
export const ROLLBACK_EFFECT = "environment.setup-rollback";

const REVIEW_COMMENTS_INPUT = {
	schemaId: "core.review-comments",
	schemaVersion: 1,
} as const;

/** The drafts location and subject the guard, validation and promotion effects
 * all act on. Everything derivable from the pinned snapshot is taken from it;
 * the effect handler resolves the configuration root for the rest. */
export interface EnvSetupSubject {
	readonly workflowId: string;
	/** The run identity (`metadata.createdAt`, pinned at start). */
	readonly runId: string;
	readonly app: string;
	readonly repository: string;
	readonly checkout: string;
	readonly draftsDir: string;
	/** The reviewed digest of every drafted file, as the validation gate recorded
	 * it in the workflow's own snapshot. The promotion refuses to publish
	 * anything else, so the approval authorises the bytes that become live. */
	readonly reviewed?: Record<string, string>;
}

export function envSetupSubject(snapshot: {
	workflowId: string;
	metadata: {
		app?: string;
		repository: string;
		worktree: string;
		setupDraftsDir?: string;
		setupReviewedDrafts?: Record<string, string>;
		createdAt: string;
	};
}): EnvSetupSubject {
	return {
		workflowId: snapshot.workflowId,
		// The run identity: guard and promotion state are keyed by it, so a
		// workflow id reused after deletion neither inherits nor conflicts with
		// the earlier run's state.
		runId: snapshot.metadata.createdAt,
		app: snapshot.metadata.app ?? "",
		repository: snapshot.metadata.repository,
		checkout: snapshot.metadata.worktree,
		draftsDir: snapshot.metadata.setupDraftsDir ?? "",
		...(snapshot.metadata.setupReviewedDrafts
			? { reviewed: snapshot.metadata.setupReviewedDrafts }
			: {}),
	};
}

function guardPayload(
	snapshot: {
		workflowId: string;
		metadata: {
			app?: string;
			repository: string;
			worktree: string;
			setupDraftsDir?: string;
			createdAt: string;
		};
	},
	phase: "baseline" | "check",
): JsonValue {
	return { ...envSetupSubject(snapshot), phase } as unknown as JsonValue;
}

export const envSetupBehaviors: Readonly<Record<string, StepBehavior>> = {
	/** The author: the one agent of the family. It writes only drafts. */
	"setup.author": {
		roles: () => [ENV_SETUP_ROLE],
		candidateRoles: () => [ENV_SETUP_ROLE],
		instructionAssetForRole: () => "env-setup.md",
		// The validation report and the developer's review comments arrive as
		// this step's context on the next attempt.
		carriesOutputContext: true,
		acceptsCommentsContext: true,
		assignmentInputs: ({ snapshot }) => {
			const subject = envSetupSubject(snapshot);
			return {
				introLines: [
					`Staged configuration root: ${subject.draftsDir ? `${subject.draftsDir}/root` : "<config>/.drafts/env-setup/<workflowId>/root"} — a complete copy of the live configuration at its own relative layout. Write every definition at its final relative path there (apps/build/*, apps/run/*, apps/compose/*, apps/kubernetes/<app>-<profile>.k8s.json, infrastructure/definitions/*, infrastructure/compose/*), never into the live configuration.`,
					"A staged path that is a symlink points at the developer's real file (the staged root preserves the live symlinks, and `env_list` lists them under `stagedSymlinks` with their targets): delete the staged symlink and write a regular file at that path instead, never write through it.",
					`App under setup: ${subject.app || "unnamed"}; its checkout is ${subject.checkout}.`,
					"Because the staged root is a complete layout, a draft's `include:` and its relative mounts resolve exactly as they will after promotion: author the file you mean to promote, not a version rewritten to fit a partial drafts tree.",
					"The app repository is read-only evidence: every definition you author is a draft, and nothing becomes live until the developer approves it.",
					"Your `env_*` tools already run against the staged root, so start, browse and debug what you authored.",
				],
				objective:
					"Author complete, runnable environment definitions for the app as drafts in the staged configuration root: build and test targets, run targets (Docker first), Kubernetes runs only if the app needs them, and any infrastructure definitions they require — with static names and ports that do not collide with other apps, OTel wiring through the AC_OTEL_* variables, and a report of what you published, the default target per action, the variables you used, and the follow-ups for the app repository.",
				permissions: [
					"read the app repository and the configuration as evidence only",
					"write definitions only under the drafts directory",
					"start, browse and debug the drafted targets through the env_* tools",
					"developer approval is required before anything is promoted",
				],
				checks: [
					"every drafted target parses, discovers and compiles",
					"the drafted targets reference the AC_OTEL_* variables",
					"host ports do not collide with another app's definition",
					"every environment variable the drafts reference exists in the configuration .env",
					"the default target per action is stated in your report, so two default-profile build targets (a Dockerfile and a host-maven script) cannot be chosen by accident",
					"the gate builds, starts and tests those default targets against the staged root before the developer is asked",
				],
			};
		},
		onEnter: ({ snapshot, enqueue }) => {
			// The staged configuration root is materialized first: the author must
			// write into a complete copy of the live configuration, or what it tests
			// is not what the developer later promotes
			// (`staged-env-setup-config-root`).
			enqueue(
				STAGE_EFFECT,
				`setup-stage:${snapshot.workflowId}:${snapshot.revision}`,
				envSetupSubject(snapshot) as unknown as JsonValue,
			);
			// The baseline is taken before the first author turn, so a write to
			// the live configuration or the checkout is visible from the start.
			// The run itself is withheld until that baseline exists: an author
			// process that could start first could write before the fingerprint
			// that is supposed to catch it.
			enqueue(
				GUARD_EFFECT,
				`setup-guard:${snapshot.workflowId}:baseline:${snapshot.revision}`,
				guardPayload(snapshot, "baseline"),
			);
			return { skipRoles: [ENV_SETUP_ROLE] };
		},
		onAgentComplete: ({ snapshot, outcome }) => {
			if (outcome !== "complete") return undefined;
			// The guard runs between the author turn and the validation, and the
			// transition waits for it: a workflow whose drafts are not the only
			// thing that changed parks instead of validating unapproved writes.
			return {
				deferTransition: true,
				effects: [
					{
						kind: GUARD_EFFECT,
						idempotencyKey: `setup-guard:${snapshot.workflowId}:check:${snapshot.revision}`,
						payload: guardPayload(snapshot, "check"),
					},
				],
			};
		},
		onEffectComplete: ({ effect }) => {
			if (effect.kind !== GUARD_EFFECT) return undefined;
			const phase = (effect.payload as { phase?: unknown } | undefined)?.phase;
			// The armed baseline is what releases the author's run; the check at
			// handoff is what lets the step move on to validation.
			if (phase === "baseline") return { runs: [{ role: ENV_SETUP_ROLE }] };
			if (phase !== "check") return undefined;
			return { transition: { outcome: "complete" } };
		},
	},
	/** The deterministic gate: structural checks plus a real start. */
	"setup.validate": {
		onEnter: ({ snapshot, enqueue }) => {
			enqueue(
				VALIDATE_EFFECT,
				`setup-validate:${snapshot.workflowId}:${snapshot.revision}`,
				envSetupSubject(snapshot) as unknown as JsonValue,
			);
			return undefined;
		},
		onEffectComplete: ({ effect }) => {
			if (effect.kind !== VALIDATE_EFFECT) return undefined;
			const report = effect.data;
			const ok =
				typeof report === "object" &&
				report !== null &&
				(report as { ok?: unknown }).ok === true;
			return {
				transition: { outcome: ok ? "complete" : "failed", output: report },
			};
		},
	},
	/** The developer gate: the draft diff, then approve or request changes. Its
	 * context carries the validation report, so the developer sees exactly the
	 * commands and targets the gate ran and their results. */
	"setup.approval": {
		carriesOutputContext: true,
		developerActions: () => [
			{
				id: ENV_SETUP_APPROVE_ACTION,
				label: "Approve and promote",
				confirmation: "confirm" as const,
				requiresInput: true,
			},
			{
				id: ENV_SETUP_REVIEW_ACTION,
				label: "Request changes",
				confirmation: "confirm" as const,
				input: REVIEW_COMMENTS_INPUT,
				requiresInput: true,
			},
		],
		acceptsCommentsContext: true,
	},
	/** The atomic promotion, with a protected backup and full rollback. Its entry
	 * runs the write guard's `check` phase first, so the promotion only ever
	 * writes over the configuration the developer approved. */
	"setup.promote": {
		onEnter: ({ snapshot, enqueue }) => {
			enqueue(
				GUARD_EFFECT,
				`setup-guard:${snapshot.workflowId}:promote:${snapshot.revision}`,
				guardPayload(snapshot, "check"),
			);
			return undefined;
		},
		onEffectComplete: ({ snapshot, effect }) => {
			if (effect.kind === GUARD_EFFECT) {
				const phase = (effect.payload as { phase?: unknown } | undefined)
					?.phase;
				if (phase !== "check") return undefined;
				return {
					effects: [
						{
							kind: PROMOTE_EFFECT,
							idempotencyKey: `setup-promote:${snapshot.workflowId}:${snapshot.revision}`,
							payload: envSetupSubject(snapshot) as unknown as JsonValue,
						},
					],
				};
			}
			if (effect.kind !== PROMOTE_EFFECT) return undefined;
			// A rolled-back promotion is a failure the graph retries (bounded), never
			// a completed step that published nothing.
			const ok =
				typeof effect.data === "object" &&
				effect.data !== null &&
				(effect.data as { ok?: unknown }).ok === true;
			return {
				transition: {
					outcome: ok ? "complete" : "failed",
					output: effect.data,
				},
			};
		},
	},
	/** The post-promotion smoke check: the real default target is started once
	 * against the live configuration. Nothing here is reachable before the
	 * developer approved. */
	"setup.smoke": {
		onEnter: ({ snapshot, enqueue }) => {
			enqueue(
				SMOKE_EFFECT,
				`setup-smoke:${snapshot.workflowId}:${snapshot.revision}`,
				envSetupSubject(snapshot) as unknown as JsonValue,
			);
			return undefined;
		},
		onEffectComplete: ({ effect }) => {
			if (effect.kind !== SMOKE_EFFECT) return undefined;
			const ok =
				typeof effect.data === "object" &&
				effect.data !== null &&
				(effect.data as { ok?: unknown }).ok === true;
			return {
				transition: {
					outcome: ok ? "complete" : "failed",
					output: effect.data,
				},
			};
		},
	},
	/** The developer's choice after a failed live start: restore exactly the
	 * previous files, or keep the promotion with the failure recorded. */
	"setup.smoke.review": {
		// The smoke report arrives as this step's context: the developer must see
		// what failed before choosing to roll back or keep the promotion.
		carriesOutputContext: true,
		acceptsCommentsContext: true,
		developerActions: () => [
			{
				id: ENV_SETUP_ROLLBACK_ACTION,
				label: "Roll back the promotion (restores the previous files)",
				confirmation: "confirm" as const,
				requiresInput: true,
			},
			{
				id: ENV_SETUP_ACCEPT_SMOKE_ACTION,
				label: "Keep the promotion anyway",
				confirmation: "confirm" as const,
				requiresInput: true,
			},
		],
	},
	/** Restore the live configuration from the promotion's own backup, then let
	 * the author resume in its staged root with the rollback report. */
	"setup.rollback": {
		onEnter: ({ snapshot, enqueue }) => {
			enqueue(
				ROLLBACK_EFFECT,
				`setup-rollback:${snapshot.workflowId}:${snapshot.revision}`,
				envSetupSubject(snapshot) as unknown as JsonValue,
			);
			return undefined;
		},
		onEffectComplete: ({ effect }) => {
			if (effect.kind !== ROLLBACK_EFFECT) return undefined;
			const ok =
				typeof effect.data === "object" &&
				effect.data !== null &&
				(effect.data as { ok?: unknown }).ok === true;
			return {
				transition: {
					outcome: ok ? "complete" : "failed",
					output: effect.data,
				},
			};
		},
	},
};
