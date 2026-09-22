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
	await t.flush();
	const frame = t.captureCharFrame();
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
		frame = t.captureCharFrame();
	}
	expect(frame).toContain("Evidence line.");
	expect(frame).toContain("Background");
	expect(frame).toContain("[1 scope");
	expect(frame).toContain("Which scope?");
	expect(frame).toContain("★ Recommended path  (d)");
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
