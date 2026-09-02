// Pane allocation for a launched run: reuse-before-spawn for persistent
// roles, split geometry for grouped triage/verification rounds. Moved
// verbatim out of cli.ts (split-workflow-god-modules).
import type { HerdrPort } from "../adapters.ts";
import { isPaneLive, resolveLiveAgent } from "../effect-runner.ts";
import type { WorkflowEngine } from "../runtime.ts";
import { stepBehavior } from "../steps/index.ts";

export function verificationPosition(
	round: Array<{ id: string }>,
	runId: string,
): { k: number; n: number } {
	const k = round.findIndex((item) => item.id === runId) + 1;
	return { k, n: round.length };
}

/**
 * Allocates the pane a run launches into. Reuse-before-spawn is authoritative:
 * persistent roles adopt the live agent's resolved pane and a new tab is
 * created only when no live agent resolves; grouped triage/verification rounds
 * keep their split geometry but anchor on siblings confirmed live through the
 * canonical-name resolver instead of raw stored pane ids.
 */
export function paneForRunFactory(
	workflowEngine: WorkflowEngine,
	repo: string,
	herdr: HerdrPort,
): (
	runId: string,
) => Promise<{ paneId: string; tabId?: string; owned: boolean }> {
	return async (runId) => {
		const run = workflowEngine.getRun(repo, runId);
		const snapshot = workflowEngine.getSnapshot(repo, run.workflowId);
		if (!snapshot.metadata.workspace)
			throw new Error("workflow workspace unavailable");
		const roundScoped = stepBehavior(run.stepId).roundScoped === true;
		// Adopt any live agent's pane instead of spawning a duplicate; fall
		// through to geometry or tab creation only when no agent resolves.
		const resolved = resolveLiveAgent(
			herdr,
			snapshot.workflowId,
			snapshot.definition.id,
			run,
		);
		if (resolved) return { paneId: resolved.paneId, owned: false };
		if (roundScoped) {
			const round = workflowEngine
				.status(repo, snapshot.workflowId)
				.runs.map((item) => workflowEngine.getRun(repo, item.id))
				.filter(
					(item) =>
						stepBehavior(item.stepId).roundScoped === true &&
						item.attempt === run.attempt &&
						!["expired", "failed"].includes(item.status),
				); // rowid order = launch order; a createdAt/id tiebreak shuffles same-ms runs
			const { k, n } = verificationPosition(round, run.id);
			const all = round.filter((item) => item.id !== run.id);
			// Screen position alone doesn't mean the pane is free: a round-1
			// verifier's pane can still sit at that position long after its own
			// run finished, so any candidate must be confirmed idle before reuse.
			const bottomPane = (anchor: string): string | undefined => {
				try {
					const layout = herdr.call("pane", "layout", "--pane", anchor) as {
						layout?: {
							panes?: Array<{ pane_id?: string; rect?: { y?: number } }>;
						};
					};
					const panes = layout.layout?.panes ?? [];
					return [...panes]
						.filter(
							(pane) =>
								pane.pane_id !== anchor &&
								pane.pane_id !== undefined &&
								!isPaneLive(herdr, pane.pane_id),
						)
						.sort((a, b) => (b.rect?.y ?? 0) - (a.rect?.y ?? 0))[0]?.pane_id;
				} catch {
					return undefined;
				}
			};
			const split = (target: string, direction: "right" | "down") => {
				try {
					const result = herdr.call(
						"pane",
						"split",
						target,
						"--direction",
						direction,
						"--ratio",
						"0.5",
					) as { pane?: { pane_id?: string; tab_id?: string } };
					return result.pane?.pane_id
						? {
								paneId: result.pane.pane_id,
								...(result.pane.tab_id ? { tabId: result.pane.tab_id } : {}),
								owned: true as const,
							}
						: undefined;
				} catch {
					return undefined;
				}
			};
			if (n >= 2) {
				// Siblings anchor by identity: resolve each live through the same
				// canonical-name resolver as every other launch path.
				const resolvedSiblings = new Map<string, string>();
				for (const sibling of all) {
					const resolved = resolveLiveAgent(
						herdr,
						snapshot.workflowId,
						snapshot.definition.id,
						sibling,
					);
					if (resolved) resolvedSiblings.set(sibling.id, resolved.paneId);
				}
				let anchor: string | undefined;
				for (const sibling of all) {
					const pane = resolvedSiblings.get(sibling.id);
					if (pane) {
						anchor = pane;
						break;
					}
				}
				if (anchor) {
					if (k === 2) {
						if (n >= 3) split(anchor, "down");
						const placed = split(anchor, "right");
						if (placed) return placed;
					} else if (k === 3) {
						// bottom full-width row was created with the second pane; reuse it, or create it now if the second launch was retried
						const spare = bottomPane(anchor);
						if (spare) return { paneId: spare, owned: false };
						const placed = split(anchor, "down");
						if (placed) return placed;
					} else if (k === 4) {
						const bottom = bottomPane(anchor);
						if (bottom) {
							const placed = split(bottom, "right");
							if (placed) return placed;
						}
						const placed = split(anchor, "down");
						if (placed) return placed;
					} else {
						const nextSibling = all[k - 3];
						const target =
							(nextSibling
								? resolvedSiblings.get(nextSibling.id)
								: undefined) ??
							bottomPane(anchor) ??
							anchor;
						if (target) {
							const placed = split(target, "down");
							if (placed) return placed;
						}
					}
				}
			}
		}
		const label = roundScoped ? "verification" : run.role;
		const result = herdr.call(
			"tab",
			"create",
			"--workspace",
			snapshot.metadata.workspace,
			"--cwd",
			snapshot.metadata.worktree,
			"--label",
			label,
		) as { root_pane?: { pane_id?: string; tab_id?: string } };
		if (!result.root_pane?.pane_id)
			throw new Error("Herdr tab create returned no pane");
		return {
			paneId: result.root_pane.pane_id,
			...(result.root_pane.tab_id ? { tabId: result.root_pane.tab_id } : {}),
			owned: true,
		};
	};
}
