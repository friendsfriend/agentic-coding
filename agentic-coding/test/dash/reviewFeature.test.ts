/** Review feature ownership tests (dashboard-module-boundaries): the feature
 * builds submission payloads as pure data and aborts in-flight review
 * observations when its owner disposes — extracted review state must not
 * outlive its owning component. */
import { expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { createRoot } from "solid-js";
import type { ObservationRequest } from "../../src/contracts/environment.ts";
import type { DashboardGateway } from "../../src/contracts/gateway.ts";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import {
	createReviewFeature,
	FINDING_ANCHOR_PLACEHOLDER,
	type ReviewFeatureContext,
	reviewCommentsForEngine,
	withFindingAnchorLines,
} from "../../src/tui/dash/review.ts";
import { clearGateway, configureGateway } from "../../src/tui/data/index.ts";

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

test("plan review reloads files when its source list changes", async () => {
	let listed = ["proposal.md"];
	configureGateway({
		observe: async (observation: ObservationRequest) => {
			if (observation.kind === "artifacts") return listed;
			if (observation.kind === "artifact-content")
				return `# ${observation.artifact}`;
			throw new Error(`unexpected ${observation.kind}`);
		},
	} as unknown as DashboardGateway);
	try {
		await createRoot(async (dispose) => {
			const feature = createReviewFeature(
				context({ profile: undefined, artifacts: () => [] }),
			);
			await feature.openPlanReview();
			expect(
				feature.reviewVisibleChanges().map((file) => file.newPath),
			).toEqual(["proposal.md"]);

			listed = ["design.md"];
			await feature.refreshReviewFiles();
			expect(
				feature.reviewVisibleChanges().map((file) => file.newPath),
			).toEqual(["design.md"]);
			dispose();
		});
	} finally {
		clearGateway();
	}
});

test("a push refresh serves the review file list from the cache and the resync forces it", async () => {
	// The worktree listing costs a ~100 ms tree walk plus the state read, and the
	// dashboard used to call this on every push event with `refresh: true`
	// (measured: 19 reads per 5 s window, i.e. over a core of Git work).
	let calls = 0;
	configureGateway({
		observe: async (observation: ObservationRequest) => {
			if (observation.kind === "local-changes") {
				calls += 1;
				return [{ newPath: `file-${calls}.ts`, linesAdded: 1 }];
			}
			if (observation.kind === "developer-review-findings") return [];
			throw new Error(`unexpected ${observation.kind}`);
		},
	} as unknown as DashboardGateway);
	try {
		await createRoot(async (dispose) => {
			const feature = createReviewFeature(
				context({
					profile: undefined,
					repo: "/cache-probe",
					workflowId: "cache-probe",
				}),
			);
			// Opening the review is user-initiated: it reads through.
			await feature.openDeveloperReview();
			expect(calls).toBe(1);
			// A push-event refresh must not force past the cache...
			await feature.refreshReviewFiles();
			expect(calls).toBe(1);
			// ...while the safety resync's forced read is authoritative.
			await feature.refreshReviewFiles(true);
			expect(calls).toBe(2);
			dispose();
		});
	} finally {
		clearGateway();
	}
});

test("a background refresh keeps the open diff's view model, so its viewport does", async () => {
	// The dashboard's safety resync re-reads the review file list about once a
	// second. A fresh view-model object per read re-created the open diff modal
	// (rows included), and the rebuilt scrollbox starts at the top of the file
	// while the selected line stays where it was.
	let diff =
		"diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-old();\n+new();\n";
	configureGateway({
		observe: async (observation: ObservationRequest) => {
			if (observation.kind === "local-changes")
				return [{ newPath: "src/a.ts", linesAdded: 1 }];
			if (observation.kind === "developer-review-findings") return [];
			if (observation.kind === "local-diff") return diff;
			throw new Error(`unexpected ${observation.kind}`);
		},
	} as unknown as DashboardGateway);
	try {
		await createRoot(async (dispose) => {
			const feature = createReviewFeature(
				context({
					profile: undefined,
					repo: "/viewport",
					workflowId: "viewport",
				}),
			);
			await feature.openDeveloperReview();
			feature.setReviewView("diff");
			const opened = feature.reviewDiffFile();
			expect(opened?.new_path).toBe("src/a.ts");

			// An unchanged re-read keeps the identity...
			await feature.refreshReviewFiles(true);
			expect(feature.reviewDiffFile()).toBe(opened);

			// ...while a real change to the open file still propagates.
			diff =
				"diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,2 @@\n-old();\n+new();\n+extra();\n";
			feature.setReviewDiff(diff);
			expect(feature.reviewDiffFile()).not.toBe(opened);
			expect(feature.reviewDiffFile()?.diff).toBe(diff);
			dispose();
		});
	} finally {
		clearGateway();
	}
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

// The approval gate's shared-infrastructure flag is the setup review's own:
// a developer review of a repository that happens to have an `infrastructure/`
// tree must not claim that a source file affects every app's live
// configuration (`add-environment-setup-workflow`).
test("the affects-all-apps flag is derived for the setup review only", () => {
	const row = (newPath: string, newFile: boolean) => ({
		newPath,
		oldPath: newPath,
		linesAdded: 1,
		linesDeleted: 1,
		newFile,
		deletedFile: false,
		renamedFile: false,
	});
	const feature = createReviewFeature(context());
	feature.setReviewKind("setup");
	const shared = feature.reviewChangeForView(
		row("infrastructure/definitions/postgres.json", false),
	);
	expect(shared.affects_all_apps).toBe(true);
	// The path stays the identity a discussion is anchored to.
	expect(shared.new_path).toBe("infrastructure/definitions/postgres.json");
	expect(
		feature.reviewChangeForView(row("apps/compose/shop-compose.yml", false))
			.affects_all_apps,
	).toBe(false);
	expect(
		feature.reviewChangeForView(
			row("infrastructure/definitions/new-service.json", true),
		).affects_all_apps,
	).toBe(false);
	// A developer review never carries the flag, whatever the path.
	feature.setReviewKind("developer");
	expect(
		feature.reviewChangeForView(row("infrastructure/terraform/main.tf", false))
			.affects_all_apps,
	).toBe(false);
	feature.dispose?.();
});

/** One press event, the same shape the keymap delivers. */
function press(name: string, shift = false): KeyEvent {
	return new KeyEvent({
		name,
		ctrl: false,
		meta: false,
		shift,
		option: false,
		sequence: name,
		number: false,
		raw: name,
		eventType: "press",
		source: "raw",
	});
}

test("a report-only debug review can author a follow-up comment", () => {
	// The debug gate reviews a report, not a diff: with no changed files there
	// is nothing to Enter into, so `c` opens the comment modal directly and the
	// follow-up cannot silently become an approval.
	const base = testDashboard();
	const debugData = () => ({
		...base,
		state: {
			...base.state,
			definition: { id: "debug", version: 806, digest: "d", label: "Debug" },
		},
	});
	createRoot((dispose) => {
		const feature = createReviewFeature(context({ data: debugData }));
		feature.setReviewKind("debug");
		feature.setReviewView("files");
		feature.setReviewChanges([]);
		expect(feature.reviewVisibleChanges()).toHaveLength(0);
		expect(feature.reviewCommentMode()).toBe(false);
		feature.handleReviewKey(press("c"));
		expect(feature.reviewCommentMode()).toBe(true);
		dispose();
	});
});

test("a dashboard refresh keeps the synthetic stage plan and report documents", async () => {
	await createRoot(async (dispose) => {
		const base = testDashboard();
		const stageState = {
			...base.state,
			definition: {
				id: "stage-test",
				version: 1,
				digest: "test",
				label: "Stage test",
			},
			revision: 7,
			stage: "grid-int",
			stageSystem: "grid-allocation",
			stageAccess: "read-only",
			stageTestPlan: {
				ticketSummary: "Check request status",
				createsData: false,
				dataCreated: [],
				knowledgeStatus: "none",
				knowledgeUsed: [],
				expectations: [
					{ id: "E1", statement: "The request is visible", priority: "high" },
				],
				routes: [{ app: "web", step: "open the request" }],
			},
			stageTestReportMarkdown: "# Stage test report\n\nRendered report body.",
			availableActions: [{ id: "approve-plan", label: "Approve plan" }],
		};
		const data = () =>
			({ ...base, state: stageState }) as unknown as ReturnType<
				typeof testDashboard
			>;
		const feature = createReviewFeature(
			context({
				data,
				requiredUserAction: () => ({
					key: "plan-review",
					title: "Plan review",
					prompt: "Review the plan",
					items: [],
				}),
			}),
		);

		// The plan gate's synthetic row and diff survive the 5-second resync.
		await feature.openPlanReview();
		expect(feature.reviewKind()).toBe("plan");
		expect(feature.reviewChanges()[0]?.newPath).toBe("stage-plan.md");
		await feature.refreshReviewFiles(true);
		expect(feature.reviewChanges().map((change) => change.newPath)).toEqual([
			"stage-plan.md",
		]);
		expect(feature.reviewView()).toBe("diff");
		expect(feature.reviewDiff()).toContain("Check request status");

		// The same resync must not replace the engine-rendered report either.
		await feature.openDeveloperReview();
		expect(feature.reviewKind()).toBe("stage");
		await feature.refreshReviewFiles(true);
		expect(feature.reviewChanges().map((change) => change.newPath)).toEqual([
			"stage-report.md",
		]);
		expect(feature.reviewDiff()).toContain("Rendered report body.");
		dispose();
	});
});

test("stage report f includes wiki by default and Shift+F explicitly skips it", async () => {
	const actions: string[] = [];
	configureGateway({
		action: async (request: { actionId: string }) => {
			actions.push(request.actionId);
			return {};
		},
	} as unknown as DashboardGateway);
	try {
		for (const [name, shifted, wiki, expected] of [
			["f", false, true, "approve-and-update-wiki"],
			["f", true, true, "approve-review"],
			["F", true, true, "approve-review"],
			["f", false, false, "approve-review"],
		] as const) {
			await createRoot(async (dispose) => {
				let finished!: () => void;
				const completion = new Promise<void>((resolve) => {
					finished = resolve;
				});
				const base = testDashboard();
				const feature = createReviewFeature(
					context({
						profile: undefined,
						data: () => ({
							...base,
							state: {
								...base.state,
								definition: {
									id: "stage-test",
									version: 1,
									digest: "test",
									label: "Stage test",
								},
								availableActions: [
									{
										id: "approve-review",
										label: "Approve report",
										confirmation: "confirm",
									},
									...(wiki
										? [
												{
													id: "approve-and-update-wiki",
													label: "Approve and update wiki",
													confirmation: "confirm",
												},
											]
										: []),
								],
							},
						}),
						requiredUserAction: () =>
							({ key: "developer-review" }) as ReturnType<
								ReviewFeatureContext["requiredUserAction"]
							>,
						setReviewFinishing: (value) => {
							if (!value) finished();
						},
					}),
				);
				feature.setReviewKind("stage");
				feature.setReviewView("diff");
				feature.handleReviewKey(press(name, shifted));
				await completion;
				expect(actions.at(-1)).toBe(expected);
				dispose();
			});
		}
		expect(actions).toHaveLength(4);
	} finally {
		clearGateway();
	}
});

function debugDashboard() {
	const base = testDashboard();
	return {
		...base,
		state: {
			...base.state,
			revision: 12,
			definition: { id: "debug", version: 1, digest: "d", label: "Debug" },
		},
	};
}

test("debug opens persisted markdown first, preserves it on refresh, and dispatches report review", async () => {
	let report = "# Summary\n\nMeasured findings.";
	let reads = 0;
	const actions: Array<{
		actionId: string;
		revision: number;
		input?: unknown;
	}> = [];
	configureGateway({
		observe: async (request: ObservationRequest) => {
			expect(request.kind).toBe("artifact-content");
			if (request.kind === "artifact-content")
				expect(request.artifact).toBe("debug-report.md");
			reads++;
			return report;
		},
		action: async (request: {
			actionId: string;
			revision: number;
			input?: unknown;
		}) => {
			actions.push(request);
			return {};
		},
	} as unknown as DashboardGateway);
	try {
		await createRoot(async (dispose) => {
			const feature = createReviewFeature(
				context({
					profile: undefined,
					data: debugDashboard,
					requiredUserAction: () => ({
						key: "developer-review",
						title: "Findings review",
						prompt: "Review report",
						items: [],
					}),
				}),
			);
			try {
				await feature.openDeveloperReview();
				expect(feature.reviewKind()).toBe("debug");
				expect(feature.reviewOpen()).toBe(true);
				expect(feature.reviewView()).toBe("diff");
				expect(feature.reviewChanges().map((file) => file.newPath)).toEqual([
					"debug-report.md",
				]);
				expect(feature.reviewDiff()).toBe(report);
				await feature.refreshReviewFiles(true);
				await feature.navigateReviewFile(1);
				expect(reads).toBe(1);
				expect(feature.reviewDiff()).toBe(report);
				feature.handleReviewKey(press("c"));
				expect(feature.reviewCommentMode()).toBe(true);
				feature.setReviewCommentMode(false);
				feature.handleReviewKey(press("escape"));
				expect(feature.reviewOpen()).toBe(false);
				expect(actions).toHaveLength(0);

				// Reopening must bypass the artifact cache so a follow-up attempt is current.
				report = "# Summary\n\nFollow-up findings.";
				await feature.openDeveloperReview();
				expect(reads).toBe(2);
				expect(feature.reviewDiff()).toBe(report);
				await feature.finishDeveloperReview();
				expect(actions.at(-1)).toMatchObject({
					actionId: "approve-review",
					revision: 12,
				});

				await feature.openDeveloperReview();
				feature.setReviewComments([
					{
						filePath: "debug-report.md",
						line: 3,
						body: "Measure the slow read.",
					},
				]);
				await feature.finishDeveloperReview();
				expect(actions.at(-1)).toMatchObject({
					actionId: "review-comments",
					revision: 12,
					input: {
						comments: [
							{
								file: "debug-report.md",
								line: 3,
								comment: "Measure the slow read.",
							},
						],
					},
				});
			} finally {
				feature.dispose();
				dispose();
			}
		});
	} finally {
		clearGateway();
	}
});

test("a debug report read that finishes after disposal cannot open a stale review", async () => {
	let release!: (content: string) => void;
	const pending = new Promise<string>((resolve) => {
		release = resolve;
	});
	configureGateway({
		observe: async () => pending,
	} as unknown as DashboardGateway);
	try {
		await createRoot(async (dispose) => {
			const feature = createReviewFeature(
				context({ profile: undefined, data: debugDashboard }),
			);
			const opening = feature.openDeveloperReview();
			expect(feature.reviewLoading()).toBe(true);
			feature.dispose();
			release("# Summary\n\nStale report.");
			await opening;
			expect(feature.reviewOpen()).toBe(false);
			dispose();
		});
	} finally {
		clearGateway();
	}
});

test("missing or empty debug reports do not open an approvable blank document", async () => {
	for (const missing of [false, true]) {
		configureGateway({
			observe: async () => {
				if (missing) throw new Error("missing report");
				return "";
			},
		} as unknown as DashboardGateway);
		try {
			await createRoot(async (dispose) => {
				const feature = createReviewFeature(
					context({ profile: undefined, data: debugDashboard }),
				);
				await feature.openDeveloperReview();
				expect(feature.reviewOpen()).toBe(false);
				expect(feature.reviewLoading()).toBe(false);
				feature.dispose();
				dispose();
			});
		} finally {
			clearGateway();
		}
	}
});
