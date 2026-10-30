import type { WorkflowEngine } from "../../src/workflow/runtime.ts";

// Reducer-only fixtures have no native host. Acknowledge their stop effects
// through the public leased result command, as the effect runner would. Do not
// bypass the stop barrier or fabricate launch tokens in the test store.
export function claimFixtureEffects(engine: WorkflowEngine, repo: string) {
	const claimed: ReturnType<WorkflowEngine["claimEffects"]> = [];
	for (let attempt = 0; attempt < 10; attempt++) {
		const effects = engine.claimEffects(repo, 100);
		claimed.push(...effects);
		const stops = effects.filter((effect) => effect.kind === "agent.stop");
		// Simulate completed dispatch too: a leased old launch is legitimately
		// a barrier even after the reducer has expired its run.
		const delivered = effects.filter(
			(effect) =>
				effect.kind === "agent.stop" || effect.kind === "agent.launch",
		);
		for (const effect of delivered) {
			if (!effect.lease) throw new Error("fixture stop has no lease");
			engine.dispatch(repo, {
				type: "effect.result",
				effectId: effect.id,
				lease: effect.lease,
				outcome: "complete",
			});
		}
		if (!stops.length) return claimed;
	}
	throw new Error("fixture stop effects did not settle");
}
