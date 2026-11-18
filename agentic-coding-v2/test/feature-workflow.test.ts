import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { featureBranch } from "../src/worktrees.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("feature names have an optional ticket, never an empty prefix or path escape", () => {
	expect(featureBranch("new-search")).toBe("feature/new-search");
	expect(featureBranch("new-search", "")).toBe("feature/new-search");
	expect(featureBranch("new-search", "   ")).toBe("feature/new-search");
	expect(featureBranch("new-search", " ABC-123 ")).toBe(
		"feature/ABC-123-new-search",
	);
	expect(featureBranch("new-search", "ABC-123")).toBe(
		"feature/ABC-123-new-search",
	);
	expect(() => featureBranch("../main")).toThrow();
	expect(() => featureBranch("search", "../ABC")).toThrow();
});

test("the orchestrator forwards an optional idea to an interactive skill session", async () => {
	const { app, fake } = await fixture(false, (config) => {
		config.skills.push({ ...config.skills[0], id: "openspec-workflow" });
	});
	fake.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("start_session", {
					skill: "openspec-workflow",
					requestId: "forward-idea",
					inputs: "Build a faster search",
				}),
				fauxToolCall("start_session", {
					skill: "openspec-workflow",
					requestId: "ask-idea",
				}),
			],
			{ stopReason: "toolUse" },
		),
		...Array.from({ length: 8 }, () => fauxAssistantMessage(fauxText("Ready"))),
	]);
	await (
		await app.home.submit(
			{
				type: "input",
				content: "Open the feature discussions",
				requestId: "route",
			},
			context,
		)
	).wait(context);
	const sessions = (await app.orchestrators.read()).filter(
		(item) => item.skill?.id === "openspec-workflow",
	);
	expect(sessions).toHaveLength(2);
	const transcripts: string[] = [];
	for (const session of sessions) {
		const conversation = await app.orchestrators.conversation(session.id);
		await conversation.waitForIdle(context);
		transcripts.push(JSON.stringify(await conversation.context(context)));
		expect(session.path).toBe(app.config.repositories[0]);
		expect(session.spawnedBy).toBe(Number(app.home.id));
	}
	expect(transcripts.join("\n")).toContain("Build a faster search");
	expect(transcripts.join("\n")).toContain("No idea has been supplied yet");
});
