/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { StatusBar } from "@agentic-coding/ui";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import type {
	DashboardData,
	DeveloperDialogueRecord,
} from "../../src/contracts/workflow";
import { App } from "../../src/tui/dash/App.tsx";
import { testDashboard } from "../../src/tui/dash/demo.ts";

function question(): DeveloperDialogueRecord {
	return {
		id: "q-1",
		workflowId: "demo",
		runId: "run-1",
		stepId: "core.implementation",
		role: "worker",
		description: "Which implementation should land?",
		options: [{ title: "Option A", value: "a" }],
		status: "pending",
		createdAt: "2026-01-01T00:00:00Z",
		expiresAt: "2026-01-02T00:00:00Z",
	};
}
function fixture(questions: DeveloperDialogueRecord[]): DashboardData {
	const dashboard = testDashboard();
	return {
		...dashboard,
		state: { ...dashboard.state, pendingQuestions: questions },
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
		agentView(value, ctx) {
			ctx.require("agent.view", String(value));
		},
		evidenceView(value, ctx) {
			ctx.require("evidence.view", String(value));
		},
	});
	onCleanup(() => dispose());
	return (
		<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
			<box style={{ flexGrow: 1, minHeight: 0 }}>
				<App
					repo="/demo"
					workflowId="demo"
					profile="test"
					testData={props.testData}
					keymap={keymap}
					active={props.active}
				/>
			</box>
			<StatusBar />
		</box>
	);
}
function capture(name: string, frame: string) {
	const root = process.env.HERDR_CLARIFICATION_EVIDENCE_DIR;
	if (root) {
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(path.join(root, `${name}.txt`), frame);
	}
}

for (const attached of [false, true])
	test(`ordinary ${attached ? "attached" : "unassigned"} clarification stays passive, including overdue records`, async () => {
		const q = question();
		if (attached)
			q.clarification = {
				attachment: {
					hostId: "home",
					conversationId: "conversation",
					epoch: 1,
				},
				delivery: { id: "delivery", status: "pending" },
			};
		const t = await testRender(
			() => <TestDashboard testData={fixture([q])} />,
			{ width: 140, height: 40 },
		);
		try {
			const frame = await t.waitForFrame((value) =>
				value.includes("1 clarification pending"),
			);
			expect(frame).toContain(
				attached
					? "Home delivery pending"
					: "awaiting explicit Home attachment",
			);
			expect(frame).not.toContain("Developer input");
			expect(frame).not.toContain("Option A");
			capture(attached ? "passive-attached" : "passive-unassigned", frame);
		} finally {
			t.renderer.destroy();
		}
	});

test("returning to a dashboard with planning questions does not open a question form or take focus", async () => {
	const [active, setActive] = createSignal(false);
	const t = await testRender(
		() => (
			<TestDashboard
				testData={fixture([
					{ ...question(), role: "planner", stepId: "core.planning" },
				])}
				active={active}
			/>
		),
		{ width: 140, height: 40 },
	);
	try {
		setActive(true);
		const frame = await t.waitForFrame((value) =>
			value.includes("1 clarification pending"),
		);
		expect(frame).not.toContain("Developer input");
		expect(frame).not.toContain("Option A");
		// Existing plan reviews still own their modal. Dismiss that review,
		// not a clarification form, before making the explicit attach gesture.
		t.mockInput.pressEscape();
		await t.waitForFrame((value) => !value.includes("Plan review"));
		t.mockInput.pressKey("a");
		const modal = await t.waitForFrame((value) =>
			value.includes("Attach clarification Home"),
		);
		expect(modal).toContain("explicit custody, not an answer");
		expect(modal).toContain("Enter attach");
		expect(modal).toContain("Esc cancel");
		capture("explicit-attachment", modal);
		t.mockInput.pressEscape();
		await t.waitForFrame(
			(value) => !value.includes("Attach clarification Home"),
		);
		expect(t.captureCharFrame()).not.toContain("Developer input");
	} finally {
		t.renderer.destroy();
	}
});

test("attachment is declared in the actual footer and complete question-mark help", async () => {
	const t = await testRender(
		() => <TestDashboard testData={fixture([question()])} />,
		{ width: 140, height: 45 },
	);
	try {
		const frame = await t.waitForFrame((value) =>
			value.includes("1 clarification pending"),
		);
		expect(frame).toContain("Plan review");
		t.mockInput.pressEscape();
		const grid = await t.waitForFrame(
			(value) => !value.includes("Plan review") && value.includes("a attach"),
		);
		expect(grid).toContain("a attach");
		t.mockInput.pressKey("?");
		const help = await t.waitForFrame((value) =>
			value.includes("Attach / reattach clarification Home"),
		);
		capture("attachment-help", help);
	} finally {
		t.renderer.destroy();
	}
});

test("stage login still opens its real Done / Abort modal", async () => {
	const q = {
		...question(),
		kind: "login-handoff" as const,
		description: "Sign in to the test stage",
		expiresAt: "2099-01-01T00:00:00Z",
		options: [
			{ title: "Done", value: "done" },
			{ title: "Abort", value: "abort" },
		],
	};
	const t = await testRender(() => <TestDashboard testData={fixture([q])} />, {
		width: 120,
		height: 40,
	});
	try {
		const frame = await t.waitForFrame((value) =>
			value.includes("Sign in to the test stage"),
		);
		expect(frame).toContain("Done");
		expect(frame).toContain("Abort");
		capture("login-unchanged", frame);
	} finally {
		t.renderer.destroy();
	}
});
