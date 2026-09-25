/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
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
		ident: "scope",
		description: "Which implementation should land?",
		context: "## Background\n\nEvidence for the decision.",
		options: [
			{
				title: "Option A",
				value: "a",
				recommended: true,
				description: "## Option detail\n\nThe A path in detail.",
			},
		],
		status: "pending",
		createdAt: "2026-01-01T00:00:00Z",
		expiresAt: "2099-01-01T00:00:00Z",
	};
}

function questionnaireItem(
	id: string,
	ident: string,
	description: string,
	itemIndex: number,
): DeveloperDialogueRecord {
	return {
		...pendingQuestion(),
		id,
		ident,
		description,
		groupId: "group-1",
		itemIndex,
		options: [
			{ title: `Option ${itemIndex + 1}`, value: `value-${itemIndex}` },
		],
	};
}

function fixture(
	questions: DeveloperDialogueRecord[] = [pendingQuestion()],
): DashboardData {
	const dashboard = testDashboard();
	return {
		...dashboard,
		state: {
			...dashboard.state,
			pendingQuestions: questions,
		},
	};
}

function TestDashboard(props: {
	testData: DashboardData;
	active?: () => boolean;
}) {
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
			active={props.active}
		/>
	);
}

test("a pending developer question opens the dashboard modal", async () => {
	const t = await testRender(() => <TestDashboard testData={fixture()} />, {
		width: 120,
		height: 40,
	});
	// The markdown context renders asynchronously, so wait for its body rather
	// than only the dialog frame: this is the context box's covering assertion.
	const frame = await t.waitForFrame((value) =>
		value.includes("Evidence for the decision."),
	);
	expect(frame).toContain("Which implementation should land?");
	expect(frame).toContain("Option A");
	expect(frame).toContain("[1 scope");
	t.renderer.destroy();
});

test("planning questions surface when the dashboard becomes active", async () => {
	const [active, setActive] = createSignal(false);
	const question = {
		...pendingQuestion(),
		workflowId: "demo",
		runId: "planning-run",
		stepId: "core.planning",
		role: "planner",
	};
	const t = await testRender(
		() => <TestDashboard testData={fixture([question])} active={active} />,
		{ width: 120, height: 40 },
	);

	setActive(true);
	const frame = await t.waitForFrame((value) =>
		value.includes("Which implementation should land?"),
	);
	expect(frame).toContain("Developer input");
	expect(frame).toContain("Option A");
	t.renderer.destroy();
});

test("d opens the selected option's markdown detail modal", async () => {
	const t = await testRender(() => <TestDashboard testData={fixture()} />, {
		width: 120,
		height: 40,
	});
	await t.waitForFrame((value) => value.includes("Developer input"));
	t.mockInput.pressKey("d");
	const frame = await t.waitForFrame((value) =>
		value.includes("The A path in detail."),
	);
	expect(frame).toContain("The A path in detail.");
	t.renderer.destroy();
});

test("page down scrolls a long option-detail markdown modal", async () => {
	const lines = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`);
	lines[0] = "ALPHA_START";
	lines[59] = "OMEGA_END";
	const t = await testRender(
		() => (
			<TestDashboard
				testData={fixture([
					{
						...pendingQuestion(),
						options: [
							{
								title: "Option A",
								value: "a",
								description: lines.join("\n\n"),
							},
						],
					},
				])}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.waitForFrame((value) => value.includes("Developer input"));
	t.mockInput.pressKey("d");
	const initial = await t.waitForFrame((value) =>
		value.includes("ALPHA_START"),
	);
	expect(initial).toContain("ALPHA_START");
	t.mockInput.pressKey("pagedown");
	const scrolled = await t.waitForFrame(
		(value) => !value.includes("ALPHA_START"),
	);
	expect(scrolled).not.toContain("ALPHA_START");
	t.renderer.destroy();
});

test("alt+enter confirms the current question and advances the questionnaire", async () => {
	const t = await testRender(
		() => (
			<TestDashboard
				testData={fixture([
					questionnaireItem("q-1", "scope", "First question?", 0),
					questionnaireItem("q-2", "tests", "Second question?", 1),
				])}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.waitForFrame((value) => value.includes("First question?"));
	t.mockInput.pressEnter({ meta: true });
	const advanced = await t.waitForFrame((value) =>
		value.includes("Second question?"),
	);
	expect(advanced).toContain("[1 scope ✓]");
	expect(advanced).toContain("[2 tests ·]");
	t.renderer.destroy();
});

test("tab and shift+tab navigate the questionnaire in both directions", async () => {
	// Three items so forward and backward resolve to different tabs: from the
	// last item Tab would wrap to the first while Shift+Tab must step back to
	// the middle, so ignoring or inverting the direction fails the assertion.
	const t = await testRender(
		() => (
			<TestDashboard
				testData={fixture([
					questionnaireItem("q-1", "scope", "First question?", 0),
					questionnaireItem("q-2", "tests", "Second question?", 1),
					questionnaireItem("q-3", "docs", "Third question?", 2),
				])}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.waitForFrame((value) => value.includes("First question?"));
	t.mockInput.pressTab();
	await t.waitForFrame((value) => value.includes("Second question?"));
	t.mockInput.pressTab();
	const forward = await t.waitForFrame((value) =>
		value.includes("Third question?"),
	);
	expect(forward).toContain("[3 docs");
	t.mockInput.pressTab({ shift: true });
	const backward = await t.waitForFrame((value) =>
		value.includes("Second question?"),
	);
	expect(backward).toContain("[2 tests");
	t.renderer.destroy();
});

test("alt+enter submits a custom response from the focused textarea", async () => {
	const t = await testRender(
		() => (
			<TestDashboard
				testData={fixture([
					questionnaireItem("q-1", "scope", "First question?", 0),
					questionnaireItem("q-2", "tests", "Second question?", 1),
				])}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.waitForFrame((value) => value.includes("First question?"));
	// Move past the single option to the custom row and enter the editor.
	t.mockInput.pressKey("j");
	t.mockInput.pressEnter();
	await t.waitForFrame((value) => value.includes("Custom response"));
	await t.mockInput.typeText("hello");
	t.mockInput.pressEnter({ meta: true });
	const advanced = await t.waitForFrame((value) =>
		value.includes("Second question?"),
	);
	expect(advanced).toContain("[1 scope ✓]");
	t.renderer.destroy();
});
