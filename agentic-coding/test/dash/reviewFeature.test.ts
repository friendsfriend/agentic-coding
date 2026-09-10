/** Review feature ownership tests (dashboard-module-boundaries): the feature
 * builds submission payloads as pure data and aborts in-flight review
 * observations when its owner disposes — extracted review state must not
 * outlive its owning component. */
import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { testDashboard } from "../../src/tui/dash/demo";
import {
	createReviewFeature,
	type ReviewFeatureContext,
	reviewCommentsForEngine,
} from "../../src/tui/dash/review";

function context(
	overrides: Partial<ReviewFeatureContext> = {},
): ReviewFeatureContext {
	return {
		repo: "/demo",
		workflowId: "demo",
		profile: "test",
		setModalActive: () => {},
		trace: () => {},
		setBusy: () => {},
		busy: () => false,
		setReviewFinishing: () => {},
		setReviewFinishingMessage: () => {},
		refresh: () => {},
		data: () => testDashboard(),
		requiredUserAction: () => undefined,
		artifacts: () => [],
		dimensions: () => ({ width: 120, height: 40 }),
		setDemoIndex: () => {},
		demoPhases: [
			"proposed",
			"apply",
			"verify",
			"developer-review",
			"archive",
			"completed",
		],
		...overrides,
	};
}

test("review comments build the same engine payload as before extraction", () => {
	expect(
		reviewCommentsForEngine([
			{ filePath: "proposal.md", line: 3, body: "Clarify scope." },
		]),
	).toEqual([{ comment: "Clarify scope.", file: "proposal.md", line: 3 }]);
	expect(
		reviewCommentsForEngine([
			{
				filePath: "design.md",
				line: 7,
				startLine: 4,
				endLine: 9,
				body: "Add a diagram.",
			},
		]),
	).toEqual([
		{
			comment: "Add a diagram.",
			file: "design.md",
			line: 7,
			startLine: 4,
			endLine: 9,
		},
	]);
	// Developer reviews carry the verifier finding identity.
	expect(
		reviewCommentsForEngine(
			[
				{
					filePath: "src/a.ts",
					line: 2,
					body: "Use const.",
					findingId: "run-1:Q-1",
				},
			],
			true,
		),
	).toEqual([
		{
			comment: "Use const.",
			file: "src/a.ts",
			line: 2,
			findingId: "run-1:Q-1",
		},
	]);
	// Plan/wiki reviews never leak a finding id.
	expect(
		reviewCommentsForEngine(
			[{ filePath: "src/a.ts", line: 2, body: "n/a", findingId: "Q-1" }],
			false,
		),
	).toEqual([{ comment: "n/a", file: "src/a.ts", line: 2 }]);
});

test("feature dispose aborts in-flight review observation controllers", async () => {
	await createRoot(async (dispose) => {
		const feature = createReviewFeature(context());
		expect(feature.reviewOpen()).toBe(false);

		// Opening the plan review creates the diff observation controller.
		await feature.openPlanReview();
		expect(feature.reviewOpen()).toBe(true);
		const inFlight = feature.reviewDiffSignal();
		expect(inFlight?.aborted).toBe(false);

		// Disposal (component unmount) cancels the in-flight observation.
		feature.dispose();
		expect(inFlight?.aborted).toBe(true);

		// Draft state belongs to the feature: reopening starts a fresh review.
		await feature.openPlanReview();
		expect(feature.reviewVisibleChanges().length).toBeGreaterThan(0);
		dispose();
	});
});

test("feature tracks draft comments and rejection state in its own signals", async () => {
	await createRoot(async (dispose) => {
		const feature = createReviewFeature(context());
		feature.setReviewComments((comments) => [
			...comments,
			{ filePath: "src/a.ts", line: 1, body: "draft" },
		]);
		expect(feature.reviewComments().map((comment) => comment.body)).toEqual([
			"draft",
		]);
		feature.setPlanRejectionOpen(true);
		expect(feature.planRejectionOpen()).toBe(true);
		expect(feature.planRejectionReasons).toEqual([
			"Needs more detail",
			"Scope is not approved",
			"Requires design changes",
			"Reject proposal",
		]);
		dispose();
	});
});
