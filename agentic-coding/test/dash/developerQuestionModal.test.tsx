/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { DeveloperDialogueRecord } from "../../src/contracts/workflow.ts";
import { DeveloperQuestionModal } from "../../src/tui/dash/ui/DeveloperQuestionModal.tsx";

function question(id: string, description: string): DeveloperDialogueRecord {
	return {
		id,
		workflowId: "workflow",
		runId: "run",
		stepId: "core.implementation",
		role: "worker",
		description,
		...(id === "one" ? { context: "bounded evidence" } : {}),
		options: [{ label: "Recommended", value: "recommended" }],
		status: "pending",
		createdAt: "2026-01-01T00:00:00Z",
		expiresAt: "2026-01-02T00:00:00Z",
	};
}

const baseProps = {
	questions: [
		question("one", "Choose the implementation"),
		question("two", "Choose the test"),
	],
	activeIndex: 0,
	promptOffset: 0,
	selected: 0,
	custom: false,
	customText: "",
	responseState: ["unanswered", "answered"],
	onCustomTextChange: () => {},
};

test("questionnaire tabs show short labels and response state", async () => {
	const t = await testRender(() => <DeveloperQuestionModal {...baseProps} />, {
		width: 100,
		height: 30,
	});
	const frame = await t.waitForFrame((value) =>
		value.includes("Choose the implementation"),
	);
	expect(frame).toContain(">[1 Choose the imple… ·]");
	expect(frame).toContain("[2 Choose the test ✓]");
	expect(frame).toContain("Choose the implementation");
	t.renderer.destroy();
});

test("narrow option modal keeps select and cancel actions visible", async () => {
	const t = await testRender(() => <DeveloperQuestionModal {...baseProps} />, {
		width: 40,
		height: 20,
	});
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Select");
	expect(frame).toContain("Cancel");
	t.renderer.destroy();
});

function richQuestion(
	id: string,
	ident: string,
	question: string,
): DeveloperDialogueRecord {
	return {
		id,
		workflowId: "workflow",
		runId: "run",
		stepId: "core.implementation",
		role: "worker",
		ident,
		description: question,
		context: "## Background\n\nEvidence line.",
		options: [
			{
				title: "Recommended path",
				value: "recommended",
				recommended: true,
				description: "## Why\n\nBecause it is smaller.",
			},
			{ title: "Alternative path", value: "alternative" },
		],
		status: "pending",
		createdAt: "2026-01-01T00:00:00Z",
		expiresAt: "2099-01-01T00:00:00Z",
	};
}

test("question tabs use the ident and options mark the recommendation and detail", async () => {
	const t = await testRender(
		() => (
			<DeveloperQuestionModal
				{...baseProps}
				questions={[richQuestion("one", "scope", "Which scope?")]}
				responseState={["unanswered"]}
			/>
		),
		{ width: 100, height: 30 },
	);
	// The markdown context renders asynchronously (tree-sitter); poll the frame
	// for its body so a broken context box fails this test instead of only the
	// question/options.
	let frame = t.captureCharFrame();
	for (
		let attempt = 0;
		attempt < 50 && !frame.includes("Evidence line.");
		attempt++
	) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		await t.flush();
		frame = t.captureCharFrame();
	}
	expect(frame).toContain("Evidence line.");
	expect(frame).toContain("Background");
	expect(frame).toContain("[1 scope");
	expect(frame).toContain("Which scope?");
	expect(frame).toContain("★ Recommended path");
	expect(frame).not.toContain("(d)");
	expect(frame).toContain("Alternative path");
	t.renderer.destroy();
});

test("custom response textarea keeps newline content", async () => {
	const values: string[] = [];
	const t = await testRender(
		() => (
			<DeveloperQuestionModal
				{...baseProps}
				activeIndex={1}
				custom
				onCustomTextChange={(value) => values.push(value)}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	t.mockInput.pressKey("a");
	t.mockInput.pressEnter();
	t.mockInput.pressKey("b");
	await t.flush();
	expect(values.at(-1)).toBe("a\nb");
	t.renderer.destroy();
});

test("decision reading area expands rationale and identifies missing explanations", async () => {
	const t = await testRender(
		() => (
			<DeveloperQuestionModal
				{...baseProps}
				questions={[richQuestion("one", "scope", "Which scope?")]}
				responseState={["unanswered"]}
			/>
		),
		{ width: 120, height: 48 },
	);
	try {
		let frame = t.captureCharFrame();
		for (
			let attempt = 0;
			attempt < 50 && !frame.includes("Because it is smaller.");
			attempt++
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			await t.flush();
			frame = t.captureCharFrame();
		}
		expect(frame).toContain("Because it is smaller.");
		expect(frame).toContain("Recommended by agent");
		expect(frame).toContain("No explanation provided by the agent.");
		expect(frame).toContain("Workflow: workflow · Run: run");
		expect(frame).toContain("Question 1 of 1 · 0 answered");
		expect(frame).not.toContain("(d)");
	} finally {
		t.renderer.destroy();
	}
});

test("a login hand-off offers Done and Abort and no custom response", async () => {
	const handoff: DeveloperDialogueRecord = {
		...question(
			"handoff",
			"Log in to Grid integration as clerk on stage grid-int",
		),
		kind: "login-handoff",
		context: "session web · deadline in 15 minutes",
		options: [
			{ label: "Done", value: "done", description: "I finished logging in." },
			{ label: "Abort", value: "abort", description: "Cancel this hand-off." },
		],
	};
	const t = await testRender(
		() => (
			<DeveloperQuestionModal
				{...baseProps}
				questions={[handoff]}
				responseState={["unanswered"]}
			/>
		),
		{ width: 110, height: 32 },
	);
	let frame = await t.waitForFrame((value) =>
		value.includes("Log in to Grid integration as clerk"),
	);
	// The two answers the hand-off accepts are the only rows: no "Custom
	// response…", because the modal cannot produce one the coordinator would
	// read (add-stage-interactive-login).
	expect(frame).toContain("Done");
	expect(frame).toContain("Abort");
	expect(frame).not.toContain("Custom response");
	// Escape is the abort, and the help row says the same word the hand-off's own
	// option uses: the key never has two names in one dialog.
	expect(frame).toMatch(/Esc\s+Abort/);
	expect(frame).not.toMatch(/Esc\s+Cancel/);
	// The role the record was raised for is in the title, so the developer knows
	// which workflow is waiting.
	expect(frame).toContain("Developer input");
	// The deadline is a local wall-clock time with its remainder, rendered by the
	// one shared formatter — never the record's own ISO instant (USAB-101).
	expect(frame).toMatch(/Expires \d{2}:\d{2} local \(/);
	expect(frame).not.toContain(handoff.expiresAt);
	frame = t.captureCharFrame();
	expect(frame).toContain("Log in to Grid integration as clerk");
	t.renderer.destroy();
});
