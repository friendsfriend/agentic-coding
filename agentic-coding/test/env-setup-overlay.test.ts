// The env-setup drafts overlay (`add-environment-setup-workflow`, task 1.2 and
// spec requirement "Drafts are runnable before approval"): the runtime half of
// the overlay — the resolver that gives a setup workflow's app runs their
// drafts directory — not only the discovery boundary that consumes one.
import { describe, expect, test } from "bun:test";
import { resolveConfigRoot } from "../src/config-root.ts";
import type { App } from "../src/server/environment/config.ts";
import { setupDraftsDir } from "../src/server/environment/setup-drafts.ts";
import { createWorkflowOwnerOverlayResolver } from "../src/server/integrations/services.ts";

const APP = { ident: "shop" } as unknown as App;
/** A drafts root this process's own configuration root owns: the resolver
 * refuses an overlay outside it, so the fixtures below are derived from it. */
const DRAFTS = setupDraftsDir(resolveConfigRoot(), "wf-1");
const FOREIGN = "/elsewhere/drafts";

function snapshot(workflowId: string, setupDraftsDir?: string) {
	return {
		workflowId,
		metadata: {
			repository: "/repo/shop",
			worktree: "/repo/shop",
			branch: "main",
			baseBranch: "main",
			baseCommit: "",
			changeId: "",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			stepEnteredAt: "2026-01-01T00:00:00.000Z",
			...(setupDraftsDir ? { setupDraftsDir } : {}),
		},
	};
}

describe("the workflow owner's drafts overlay", () => {
	test("a setup workflow resolves the drafts root it pinned at start", () => {
		const resolve = createWorkflowOwnerOverlayResolver({
			targets: () => ["/repo/shop"],
			snapshot: (_target, id) => snapshot(id, DRAFTS) as never,
		});
		expect(resolve("workflow:wf-1", APP)).toBe(DRAFTS);
	});

	test("an overlay outside this configuration's drafts root resolves to none", () => {
		// The pinned value lives in the workflow's own store, which the checkout
		// can be written through, so it is untrusted on read: a foreign directory
		// means the run resolves the live configuration instead.
		const resolve = createWorkflowOwnerOverlayResolver({
			targets: () => ["/repo/shop"],
			snapshot: (_target, id) => snapshot(id, FOREIGN) as never,
		});
		expect(resolve("workflow:wf-1", APP)).toBeUndefined();
	});

	test("a workflow without a pinned drafts root resolves no overlay", () => {
		const resolve = createWorkflowOwnerOverlayResolver({
			targets: () => ["/repo/shop"],
			snapshot: (_target, id) => snapshot(id) as never,
		});
		expect(resolve("workflow:wf-1", APP)).toBeUndefined();
	});

	test("an unknown workflow and a failing read resolve no overlay", () => {
		const unknown = createWorkflowOwnerOverlayResolver({
			targets: () => ["/repo/shop"],
			snapshot: (_target, id) => snapshot(`${id}-other`) as never,
		});
		expect(unknown("workflow:wf-1", APP)).toBeUndefined();
		const failing = createWorkflowOwnerOverlayResolver({
			targets: () => ["/repo/shop", "/repo/other"],
			snapshot: (target, id) => {
				if (target === "/repo/shop") throw new Error("no such workflow");
				return snapshot(id, DRAFTS) as never;
			},
		});
		// A snapshot lookup that throws is skipped, never propagated: the overlay
		// is an optimization over the live configuration, not a new failure mode.
		expect(failing("workflow:wf-1", APP)).toBe(DRAFTS);
	});
});
