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
export const GUARD_EFFECT = "environment.setup-guard";
export const VALIDATE_EFFECT = "environment.validate";
export const PROMOTE_EFFECT = "environment.promote";

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
}

export function envSetupSubject(snapshot: {
	workflowId: string;
	metadata: {
		app?: string;
		repository: string;
		worktree: string;
		setupDraftsDir?: string;
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
					`Drafts destination: ${subject.draftsDir || "<config>/.drafts/env-setup/<workflowId>"} — mirror the configuration layout there (apps/build/*, apps/run/*, apps/compose/*, apps/kubernetes/<app>-<profile>.k8s.json, infrastructure/definitions/*, infrastructure/compose/*).`,
					`App under setup: ${subject.app || "unnamed"}; its checkout is ${subject.checkout}.`,
					"The app repository is read-only evidence: every definition you author is a draft, and nothing becomes live until the developer approves it.",
					"Your `env_*` tools already run against the drafts (the slot resolves drafts before the live configuration), so start, browse and debug what you authored.",
				],
				objective:
					"Author complete, runnable environment definitions for the app as drafts: build and test targets, run targets (Docker first), Kubernetes runs only if the app needs them, and any infrastructure definitions they require — with static names and ports that do not collide with other apps, OTel wiring through the AC_OTEL_* variables, and a report of what you published, the variables you used, and the follow-ups for the app repository.",
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
				],
			};
		},
		onEnter: ({ snapshot, enqueue }) => {
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
	/** The developer gate: the draft diff, then approve or request changes. */
	"setup.approval": {
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
};
