// The stage usage bounds (`add-stage-testing-foundation`, tasks 3.3–3.5).
//
// The registry is the only thing that decides whether a stage open is admitted:
// an exclusive lease, a per-workflow session cap and a rolling minute of browser
// calls. Its inputs are a clock and the pool's live session count, so all three
// are exercised here with both of them under the test's own control — no browser,
// no server, no clock.
//
// One rule is what makes the bounds real rather than decorative: an open that has
// been admitted but has not settled *counts*, because Chromium's `newContext`
// round trip is exactly the window in which two workflows could otherwise both
// believe they hold an exclusive stage.
import { describe, expect, test } from "bun:test";
import {
	StageLimitError,
	StageUsageRegistry,
} from "../src/server/stages/limits.ts";

const OWNER = "workflow:wf-a";
const OTHER = "workflow:wf-b";

/** A registry over a session count and a clock the test moves by hand. */
function fixture(options: { readonly sessions?: number } = {}) {
	let now = 1_000_000;
	const sessions = new Map<string, number>();
	sessions.set(`${OWNER}\u0000grid-int`, options.sessions ?? 0);
	const registry = new StageUsageRegistry({
		now: () => now,
		stageSessions: (owner, stage) =>
			sessions.get(`${owner}\u0000${stage}`) ?? 0,
	});
	return {
		registry,
		advance(ms: number) {
			now += ms;
		},
		setSessions(owner: string, stage: string, count: number) {
			sessions.set(`${owner}\u0000${stage}`, count);
		},
	};
}

function refusal(run: () => unknown): StageLimitError {
	try {
		run();
	} catch (error) {
		if (error instanceof StageLimitError) return error;
		throw error;
	}
	throw new Error("expected a StageLimitError");
}

describe("stage limits", () => {
	test("the session bound counts an open that has not settled yet", () => {
		const { registry } = fixture();
		const admission = registry.open({
			stage: "grid-int",
			exclusive: false,
			maxSessions: 1,
			owner: OWNER,
		});
		// No session exists yet — the context is still being created — and the
		// bound is already spent.
		const refused = refusal(() =>
			registry.open({
				stage: "grid-int",
				exclusive: false,
				maxSessions: 1,
				owner: OWNER,
			}),
		);
		expect(refused.code).toBe("stage-session-limit");
		// Settling it *twice* gives one admission back, not two.
		admission.settle();
		admission.settle();
		expect(() =>
			registry.open({
				stage: "grid-int",
				exclusive: false,
				maxSessions: 1,
				owner: OWNER,
			}),
		).not.toThrow();
	});

	test("an exclusive stage is held while its first open is still in flight", () => {
		const { registry } = fixture();
		const admission = registry.open({
			stage: "grid-int",
			exclusive: true,
			maxSessions: 2,
			owner: OWNER,
		});
		// The second workflow asks before any session exists.
		expect(registry.holder("grid-int")).toBe(OWNER);
		const refused = refusal(() =>
			registry.open({
				stage: "grid-int",
				exclusive: true,
				maxSessions: 2,
				owner: OTHER,
			}),
		);
		expect(refused.code).toBe("stage-held");
		expect(refused.message).toContain(OWNER);

		// A workflow may re-open a stage it already holds.
		const again = registry.open({
			stage: "grid-int",
			exclusive: true,
			maxSessions: 2,
			owner: OWNER,
		});
		again.settle();
		admission.settle();
		// Both opens settled and neither left a session behind, so the stage is free.
		expect(registry.holder("grid-int")).toBeUndefined();
	});

	test("a lease whose holder has neither a session nor an open is gone", () => {
		const { registry, setSessions } = fixture();
		const admission = registry.open({
			stage: "grid-int",
			exclusive: true,
			maxSessions: 2,
			owner: OWNER,
		});
		admission.settle();
		// The context failed, so no session was ever registered: the next workflow
		// may take the stage.
		expect(registry.holder("grid-int")).toBeUndefined();
		const taken = registry.open({
			stage: "grid-int",
			exclusive: true,
			maxSessions: 2,
			owner: OTHER,
		});
		taken.settle();
		// Settled and sessionless again: the lease is not sticky.
		expect(registry.holder("grid-int")).toBeUndefined();

		// A live session keeps a lease: the lease ends when the sessions do
		// (`closeOwner`, the idle sweep, a crashed context — all of them end at the
		// pool, so there is no second lifecycle to keep in step).
		setSessions(OTHER, "grid-int", 1);
		registry
			.open({
				stage: "grid-int",
				exclusive: true,
				maxSessions: 2,
				owner: OTHER,
			})
			.settle();
		expect(registry.holder("grid-int")).toBe(OTHER);
		setSessions(OTHER, "grid-int", 0);
		expect(registry.holder("grid-int")).toBeUndefined();
	});

	test("the rolling minute expires and reports how long to wait", () => {
		const { registry, advance } = fixture();
		const count = () =>
			registry.countAction({
				stage: "grid-int",
				owner: OWNER,
				maxActionsPerMinute: 2,
			});
		count();
		advance(30_000);
		count();
		const refused = refusal(() => count());
		expect(refused.code).toBe("stage-rate-limit");
		// The window's first action was 30 s ago, so that is when a slot returns.
		expect(refused.retryAfterMs).toBe(30_000);
		// A different workflow has its own window.
		expect(() =>
			registry.countAction({
				stage: "grid-int",
				owner: OTHER,
				maxActionsPerMinute: 2,
			}),
		).not.toThrow();
		advance(30_001);
		expect(() => count()).not.toThrow();
	});

	test("releasing a workflow forgets its windows, never its admission", () => {
		const { registry } = fixture();
		registry.countAction({
			stage: "grid-int",
			owner: OWNER,
			maxActionsPerMinute: 1,
		});
		const admission = registry.open({
			stage: "grid-int",
			exclusive: false,
			maxSessions: 1,
			owner: OWNER,
		});
		registry.release(OWNER);
		// The rate window is gone with the run...
		expect(() =>
			registry.countAction({
				stage: "grid-int",
				owner: OWNER,
				maxActionsPerMinute: 1,
			}),
		).not.toThrow();
		// ...and the in-flight admission still holds the session slot.
		expect(
			refusal(() =>
				registry.open({
					stage: "grid-int",
					exclusive: false,
					maxSessions: 1,
					owner: OWNER,
				}),
			).code,
		).toBe("stage-session-limit");
		admission.settle();
	});
});
