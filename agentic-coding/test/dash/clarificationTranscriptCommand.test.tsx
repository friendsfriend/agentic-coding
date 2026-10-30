/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { AgentSessionView } from "../../src/tui/dash/ui/AgentSessionView.tsx";
import { orchestratorSessionCommands } from "../../src/tui/orchestrator/session-commands.ts";

test("ordinary Home transcript executes only the deliberate parameterized attachment command", async () => {
	const [draft, setDraft] = createSignal(
		"/attach selected-workflow /disposable/project with spaces",
	);
	const calls: string[] = [];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="orchestrator"
				blocks={[]}
				working={false}
				connection="connected"
				history={[]}
				models={["fake/model"]}
				thinkingLevels={["off"]}
				draft={draft()}
				onDraftChange={setDraft}
				onHistoryAppend={() => {}}
				onSubmit={(text) => calls.push(`model:${text}`)}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
				extraCommands={orchestratorSessionCommands(
					() => calls.push("new"),
					(argument) => calls.push(`attach:${argument}`),
				)}
			/>
		),
		{ width: 130, height: 35 },
	);
	try {
		await t.renderOnce();
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(calls).toEqual([
			"attach:selected-workflow /disposable/project with spaces",
		]);
		expect(draft()).toBe("");
		for (const text of [
			"please attach that other workflow",
			"/attachment selected-workflow",
		]) {
			setDraft(text);
			await t.renderOnce();
			t.mockInput.pressEnter();
			await t.renderOnce();
			expect(calls.at(-1)).toBe(`model:${text}`);
		}
		expect(calls.filter((item) => item.startsWith("attach:"))).toHaveLength(1);
		setDraft("/att");
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("/attach");
		expect(t.captureCharFrame()).toContain("clarification custody");
	} finally {
		t.renderer.destroy();
	}
});
