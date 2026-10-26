/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { DashboardGateway } from "../../src/contracts/gateway.ts";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import { createReviewFeature } from "../../src/tui/dash/review.ts";
import { ReviewRoute } from "../../src/tui/dash/routes/ReviewRoute.tsx";
import { clearGateway, configureGateway } from "../../src/tui/data/index.ts";

test("debug review renders its report as markdown rather than an empty code diff", async () => {
	configureGateway({
		observe: async () =>
			"# Summary\n\nConfirmed synthetic finding.\n\n## Reproduction\n\nRun the isolated probe.",
	} as unknown as DashboardGateway);
	let feature!: ReturnType<typeof createReviewFeature>;
	let rendered: Awaited<ReturnType<typeof testRender>> | undefined;
	try {
		rendered = await testRender(
			() => {
				const base = testDashboard();
				feature = createReviewFeature({
					repo: "/demo",
					workflowId: "demo",
					setModalActive: () => {},
					trace: () => {},
					setBusy: () => {},
					busy: () => false,
					setReviewFinishing: () => {},
					setReviewFinishingMessage: () => {},
					refresh: () => {},
					data: () => ({
						...base,
						state: {
							...base.state,
							definition: {
								id: "debug",
								version: 1,
								digest: "d",
								label: "Debug",
							},
						},
					}),
					requiredUserAction: () => ({
						key: "developer-review",
						title: "Findings review",
						prompt: "Read report",
						items: [],
					}),
					artifacts: () => ["debug-report.md"],
					dimensions: () => ({ width: 120, height: 40 }),
					setDemoIndex: () => {},
					demoPhases: [],
				});
				return (
					<ReviewRoute
						feature={feature}
						modalTop={() => "review"}
						setModalActive={() => {}}
					/>
				);
			},
			{ width: 120, height: 40 },
		);
		await feature.openDeveloperReview();
		let frame = "";
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			await rendered.renderOnce();
			frame = rendered.captureCharFrame();
			if (frame.includes("Confirmed synthetic finding.")) break;
			await Bun.sleep(20);
		}
		expect(frame).toContain("debug-report.md");
		expect(frame).toContain("Confirmed synthetic finding.");
		expect(frame).toContain("Reproduction");
		expect(frame).not.toContain("# Summary");
		expect(frame).toContain("Finish review");
	} finally {
		feature?.dispose();
		rendered?.renderer.destroy();
		clearGateway();
	}
});
