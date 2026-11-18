// A session opened for a skill is the interactive path: the developer talks to it and it
// runs the exact text they read. The fence is identity plus digest, so the same ids never
// open a session running something else.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { digest, loadConfig } from "../src/config.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

const instructions = "Own one OpenSpec change from exploration to archive.";

test("a skill session records the skill it was opened with and runs its text", async () => {
	const directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-skill-session-")),
	);
	const { app } = await fixture(false, (config) => {
		config.profiles = [];
		config.repositories = [directory];
		config.skills = [
			{
				id: "openspec-workflow",
				origin: "system",
				content: instructions,
				description: "workflow",
				digest: digest(instructions),
			},
		];
	});
	const created = await app.orchestrators.create({
		path: directory,
		skill: "openspec-workflow",
		revision: digest(instructions),
	});
	expect(created.skill).toEqual({
		id: "openspec-workflow",
		digest: digest(instructions),
	});
	// The title defaults to the skill, so the sidebar says what the session is for.
	expect(created.title).toBe("openspec-workflow");
	// It runs the skill's own text, followed by the rules every conversation keeps.
	const agent = await (await app.orchestrators.conversation(created.id)).agent(
		context,
	);
	expect(agent.instructions).toContain(instructions);
	expect(agent.instructions).toContain(
		"You work directly in the checkout this conversation was opened in",
	);
	// A skill replaces the orchestrator's role framing, never the delegation brief:
	// without it a skill that spawns sub-agents would not know how to.
	expect(agent.instructions).toContain("Use catalog to see ALL profiles");
	expect(agent.instructions).not.toContain(
		"You are the agentic-coding-v2 orchestrator",
	);
});

test("an unknown skill or a stale digest is refused instead of opened", async () => {
	const directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-skill-fence-")),
	);
	const { app } = await fixture(false, (config) => {
		config.profiles = [];
		config.repositories = [directory];
		config.skills = [
			{
				id: "review",
				origin: "system",
				content: instructions,
				description: "review",
				digest: digest(instructions),
			},
		];
	});
	await expect(
		app.orchestrators.create({
			path: directory,
			skill: "no-such-skill",
			revision: digest(instructions),
		}),
	).rejects.toThrow("Unknown skill");
	// The digest is the text the developer saw; anything else would open a session
	// running instructions they never read.
	await expect(
		app.orchestrators.create({
			path: directory,
			skill: "review",
			revision: digest("something else"),
		}),
	).rejects.toThrow("Loaded skill changed since it was read");
	// A plain session is still unrestricted: the skill is an option, not a gate.
	const plain = await app.orchestrators.create({ path: directory });
	expect(plain.skill).toBeUndefined();
});

test("the driver spawns skills the host actually loaded", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-skill-catalog-")),
	);
	const config = loadConfig(
		path.join(root, "state"),
		root,
		path.join(root, "config"),
	);
	const loaded = new Set(config.skills.map((item) => item.id));
	const driver = config.skills.find((item) => item.id === "openspec-workflow");
	expect(driver).toBeDefined();
	// Every skill the driver names must exist, or start_task refuses it at admission
	// and the workflow stops halfway through a change.
	const verifier = config.skills.find((item) => item.id === "verify-workflow");
	expect(verifier).toBeDefined();
	const spawns = [...(driver?.content ?? "").matchAll(/skill: "([^"]+)"/g)].map(
		(match) => match[1],
	);
	expect(spawns.length).toBeGreaterThan(2);
	for (const id of spawns) expect(loaded.has(id)).toBe(true);
	// The official OpenSpec workflow skills are the ones doing the work.
	for (const id of [
		"performance-verifier",
		"code-quality-verifier",
		"migration-verifier",
		"security-verifier",
		"concurrency-verifier",
		"openspec-verifier",
		"openspec-explore",
		"openspec-propose",
		"openspec-apply-change",
		"openspec-verify-change",
		"openspec-archive-change",
	])
		expect(loaded.has(id)).toBe(true);
});
