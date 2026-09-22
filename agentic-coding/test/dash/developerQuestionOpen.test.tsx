/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import type {
	DashboardData,
	DeveloperDialogueRecord,
} from "../../src/contracts/workflow";
import { App } from "../../src/tui/dash/App.tsx";
import { testDashboard } from "../../src/tui/dash/demo.ts";

function pendingQuestion(): DeveloperDialogueRecord {
	return {
		id: "q-1",
		workflowId: "demo-optional-realisation-date",
		runId: "run-1",
		stepId: "core.implementation",
		role: "worker",
		description: "Which implementation should land?",
		options: [{ label: "Option A", value: "a" }],
		status: "pending",
		createdAt: "2026-01-01T00:00:00Z",
		expiresAt: "2099-01-01T00:00:00Z",
	};
}

function fixture(): DashboardData {
	const dashboard = testDashboard();
	return {
		...dashboard,
		state: {
			...dashboard.state,
			pendingQuestions: [pendingQuestion()],
		},
	};
}

function TestDashboard(props: { testData: DashboardData }) {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const dispose = keymap.registerLayerFields({
		name() {},
		appView(value, ctx) {
			ctx.require("app.view", String(value));
		},
		activeModal(value, ctx) {
			ctx.require("modal.active", String(value));
		},
	});
	onCleanup(() => dispose());
	return (
		<App
			repo="/demo"
			workflowId="demo"
			profile="test"
			testData={props.testData}
			keymap={keymap}
		/>
	);
}

test("a pending developer question opens the dashboard modal", async () => {
	const t = await testRender(() => <TestDashboard testData={fixture()} />, {
		width: 120,
		height: 40,
	});
	const frame = await t.waitForFrame((value) =>
		value.includes("Developer input"),
	);
	expect(frame).toContain("Which implementation should land?");
	expect(frame).toContain("Option A");
	t.renderer.destroy();
});
