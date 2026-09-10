/** Review feature ownership tests (dashboard-module-boundaries): the feature
 * builds submission payloads as pure data and aborts in-flight review
 * observations when its owner disposes — extracted review state must not
 * outlive its owning component. */
import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { testDashboard } from "../../src/tui/dash/demo";
import {
	createReviewFeature,
	FINDING_ANCHOR_PLACEHOLDER,
	type ReviewFeatureContext,
	reviewCommentsForEngine,
	withFindingAnchorLines,
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

test("missing finding anchors are injected as synthetic diff lines", () => {
	const diff =
		"diff --git a/src/example.ts b/src/example.ts\n@@ -1,1 +1,1 @@\n-old();\n+new();\n";
	const augmented = withFindingAnchorLines(diff, "src/example.ts", [
		{
			id: "run-1:Q-2",
			originalId: "Q-2",
			severity: "info",
			path: "src/example.ts",
			line: 99,
			detail: "Helper is never used.",
		},
	]);
	expect(augmented).toContain("@@ -99,1 +99,1 @@");
	expect(augmented).toContain(`+${FINDING_ANCHOR_PLACEHOLDER}`);
});

test("visible anchors and other files are left untouched", () => {
	const diff =
		"diff --git a/src/example.ts b/src/example.ts\n@@ -1,1 +1,1 @@\n-old();\n+new();\n";
	const visible = withFindingAnchorLines(diff, "src/example.ts", [
		{
			id: "run-1:Q-1",
			originalId: "Q-1",
			severity: "warning",
			path: "src/example.ts",
			line: 1,
			detail: "Visible.",
		},
	]);
	expect(visible).toBe(diff);
	const otherFile = withFindingAnchorLines(diff, "src/example.ts", [
		{
			id: "run-1:Q-3",
			originalId: "Q-3",
			severity: "info",
			path: "src/other.ts",
			line: 99,
			detail: "Other file.",
		},
	]);
	expect(otherFile).toBe(diff);
});

test("pathless and old-path findings never inject a bare placeholder", () => {
	const diff = "diff --git a/src/example.ts b/src/example.ts\n";
	const pathless = withFindingAnchorLines(diff, "src/example.ts", [
		{
			id: "run-1:Q-1",
			originalId: "Q-1",
			severity: "warning",
			line: 42,
			detail: "General.",
		},
	]);
	expect(pathless).toBe(diff);
	const renamed = withFindingAnchorLines(diff, "src/new.ts", [
		{
			id: "run-1:Q-2",
			originalId: "Q-2",
			severity: "warning",
			path: "src/old.ts",
			line: 42,
			detail: "Anchored to the old path.",
		},
	]);
	expect(renamed).toBe(diff);
});

test("line-less findings anchor at line 1 like the discussion builder", () => {
	const diff =
		"diff --git a/src/example.ts b/src/example.ts\n@@ -2,1 +2,1 @@\n-old();\n+new();\n";
	const augmented = withFindingAnchorLines(diff, "src/example.ts", [
		{
			id: "run-1:Q-1",
			originalId: "Q-1",
			severity: "info",
			path: "src/example.ts",
			detail: "Legacy finding without a line.",
		},
	]);
	expect(augmented).toContain("@@ -1,1 +1,1 @@");
	expect(augmented).toContain(`+${FINDING_ANCHOR_PLACEHOLDER}`);
});

test("findings on one missing anchor inject a single hunk", () => {
	const diff = "diff --git a/src/example.ts b/src/example.ts\n";
	const augmented = withFindingAnchorLines(diff, "src/example.ts", [
		{
			id: "run-1:Q-1",
			originalId: "Q-1",
			severity: "warning",
			path: "src/example.ts",
			line: 4,
			detail: "First.",
		},
		{
			id: "run-1:Q-2",
			originalId: "Q-2",
			severity: "info",
			path: "src/example.ts",
			line: 4,
			detail: "Second.",
		},
	]);
	expect(augmented.match(/@@ -4,1 \+4,1 @@/g)?.length).toBe(1);
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
