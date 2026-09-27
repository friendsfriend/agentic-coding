import { runMultiplexer } from "../../multiplexer/boundary.ts";
import type { MultiplexerPort } from "../../multiplexer/port.ts";
import { isPaneLiveAsync, resolveLiveAgentAsync } from "../effect-runner.ts";
import type { WorkflowEngine } from "../runtime.ts";
import type { StepBehavior } from "../steps/types.ts";
import { agentTabLabel, agentTabRoleName } from "../tab-status.ts";
import { registry as defaultRegistry } from "./registry.ts";

/** Tab/pane group a round-scoped step splits into. Runs share a tab only when
 * their group matches: `groupByRole` resolves the launching run's own role so
 * each verifier role owns its own tab, while the default keeps legacy
 * round-scoped steps grouped as `verification`. Returns undefined for
 * ungrouped (persistent-role) steps. */
function paneGroup(
	behavior: StepBehavior | undefined,
	role: string,
): string | undefined {
	if (behavior?.roundScoped !== true) return undefined;
	if (behavior.groupByRole === true) return role;
	return behavior.paneGroup ?? "verification";
}

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
 * created only when no live agent resolves; grouped rounds keep their split
 * geometry but only among runs in the same pane group (triage owns a constant
 * group, verifier roles each own their own), anchoring on siblings confirmed
 * live through the canonical-name resolver instead of raw stored pane ids.
 */
export function paneForRunFactory(
	workflowEngine: WorkflowEngine,
	repo: string,
	port: MultiplexerPort,
): (
	runId: string,
) => Promise<{ paneId: string; tabId?: string; owned: boolean }> {
	return async (runId) => {
		const run = workflowEngine.getRun(repo, runId);
		const snapshot = workflowEngine.getSnapshot(repo, run.workflowId);
		if (!snapshot.metadata.workspace)
			throw new Error("workflow workspace unavailable");
		const stepRegistry = workflowEngine.registry ?? defaultRegistry;
		const definition = stepRegistry.definition(
			snapshot.definition.id,
			snapshot.definition.version,
			snapshot.definition.digest,
		);
		const behavior = stepRegistry.stepForDefinition(
			definition,
			run.stepId,
		).behavior;
		const group = paneGroup(behavior, run.role);
		const roundScoped = group !== undefined;
		// Adopt any live agent's pane instead of spawning a duplicate; fall
		// through to geometry or tab creation only when no agent resolves.
		const resolved = await resolveLiveAgentAsync(
			port,
			snapshot.workflowId,
			snapshot.definition.id,
			run,
			undefined,
			stepRegistry.stepForDefinition(definition, run.stepId),
		);
		if (resolved)
			return {
				paneId: resolved.paneId,
				...(resolved.tabId ? { tabId: resolved.tabId } : {}),
				owned: false,
			};
		if (roundScoped) {
			const round = workflowEngine
				.status(repo, snapshot.workflowId)
				.runs.map((item) => workflowEngine.getRun(repo, item.id))
				.filter(
					(item) =>
						paneGroup(
							stepRegistry.stepForDefinition(definition, item.stepId).behavior,
							item.role,
						) === group &&
						item.attempt === run.attempt &&
						!["expired", "failed"].includes(item.status),
				); // rowid order = launch order; a createdAt/id tiebreak shuffles same-ms runs
			const { k, n } = verificationPosition(round, run.id);
			const all = round.filter((item) => item.id !== run.id);
			// Screen position alone doesn't mean the pane is free: a round-1
			// verifier's pane can still sit at that position long after its own
			// run finished, so any candidate must be confirmed idle before reuse.
			const bottomPane = async (
				anchor: string,
			): Promise<string | undefined> => {
				try {
					const layout = await runMultiplexer(port.paneLayout(anchor));
					const idle: Array<{ paneId: string; y: number }> = [];
					for (const pane of layout.panes) {
						if (
							pane.paneId === anchor ||
							(await isPaneLiveAsync(port, pane.paneId))
						)
							continue;
						idle.push({ paneId: pane.paneId, y: pane.y });
					}
					return idle.sort((a, b) => b.y - a.y)[0]?.paneId;
				} catch {
					return undefined;
				}
			};
			const split = async (target: string, direction: "right" | "down") => {
				try {
					const result = await runMultiplexer(
						port.paneSplit({ target, direction, ratio: 0.5 }),
					);
					return {
						paneId: result.paneId,
						...(result.tabId ? { tabId: result.tabId } : {}),
						owned: true as const,
					};
				} catch {
					return undefined;
				}
			};
			if (n >= 2) {
				// Siblings anchor by identity: resolve each live through the same
				// canonical-name resolver as every other launch path.
				const resolvedSiblings = new Map<string, string>();
				for (const sibling of all) {
					const resolved = await resolveLiveAgentAsync(
						port,
						snapshot.workflowId,
						snapshot.definition.id,
						sibling,
						undefined,
						stepRegistry.stepForDefinition(definition, sibling.stepId),
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
						if (n >= 3) await split(anchor, "down");
						const placed = await split(anchor, "right");
						if (placed) return placed;
					} else if (k === 3) {
						// bottom full-width row was created with the second pane; reuse it, or create it now if the second launch was retried
						const spare = await bottomPane(anchor);
						if (spare) return { paneId: spare, owned: false };
						const placed = await split(anchor, "down");
						if (placed) return placed;
					} else if (k === 4) {
						const bottom = await bottomPane(anchor);
						if (bottom) {
							const placed = await split(bottom, "right");
							if (placed) return placed;
						}
						const placed = await split(anchor, "down");
						if (placed) return placed;
					} else {
						const nextSibling = all[k - 3];
						const target =
							(nextSibling
								? resolvedSiblings.get(nextSibling.id)
								: undefined) ??
							(await bottomPane(anchor)) ??
							anchor;
						if (target) {
							const placed = await split(target, "down");
							if (placed) return placed;
						}
					}
				}
			}
		}
		const label = agentTabLabel(
			agentTabRoleName(group ?? run.role),
			run.status,
		);
		const result = await runMultiplexer(
			port.tabCreate({
				workspaceId: snapshot.metadata.workspace,
				cwd: snapshot.metadata.worktree,
				label,
			}),
		);
		return {
			paneId: result.rootPaneId,
			...(result.tabId ? { tabId: result.tabId } : {}),
			owned: true,
		};
	};
}
