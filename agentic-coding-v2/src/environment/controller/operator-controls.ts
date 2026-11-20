import * as z from "zod/v4";
import type { Environments } from "../manager.ts";

const recovery = z.strictObject({
	runId: z.string().min(1).max(128),
	revision: z.number().int().min(1),
});

/** Only handed to the separately authenticated operator listener, never MCP. */
export function operatorControls(manager: Environments) {
	const drafts = manager.drafts;
	return async (route: string, method: string, body: unknown) => {
		if (method === "GET") {
			switch (route) {
				case "drafts":
					return drafts.list();
				case "recovery/runs":
					return manager.recoveryRuns();
				case "trees":
					return drafts.trees();
				case "preflights":
					return drafts.preflights();
				case "promotion-attempts":
					return drafts.attempts();
				case "promotions":
					return drafts.promotions();
			}
		}
		if (method !== "POST") return undefined;
		const input = z.record(z.string(), z.unknown()).parse(body);
		switch (route) {
			case "recovery/inspect":
				return manager.recoveryRuns(
					z.strictObject({ runId: z.string().min(1).max(128) }).parse(input)
						.runId,
				);
			case "recovery/revoke":
				return manager.operator.revoke(input);
			case "drafts/read":
				return drafts.read(
					z.strictObject({ id: z.string().min(1).max(80) }).parse(input).id,
				);
			case "drafts/save":
				return drafts.save(input);
			case "drafts/capture-base":
				return drafts.captureBase(input);
			case "drafts/save-source":
				return drafts.saveSource(input);
			case "drafts/remove-source":
				return drafts.removeSource(input);
			case "drafts/preflight":
				return drafts.preflight(input);
			case "drafts/report":
				return drafts.report(
					z.strictObject({ id: z.string().min(1).max(80) }).parse(input).id,
				);
			case "drafts/promote":
				return drafts.promote(input);
			case "drafts/promotion":
				return drafts.promotion(
					z.strictObject({ id: z.string().min(1).max(80) }).parse(input).id,
				);
			case "drafts/remove":
				return drafts.removeDraft(input);
			case "drafts/release-tree":
				return drafts.releaseTree(input);
			case "drafts/release-temporary-tree":
				return drafts.releaseTemporaryTree(input);
			case "drafts/acknowledge-tree-cleanup":
				return drafts.acknowledgeTreeCleanup(input);
			case "drafts/acknowledge-attempt":
				return drafts.acknowledgeAttempt(input);
			case "recovery/acknowledge": {
				const { runId, revision } = recovery.parse(input);
				await manager.acknowledge(runId, revision);
				return { acknowledged: true };
			}
		}
		return undefined;
	};
}
