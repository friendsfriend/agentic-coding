import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { taskRepositories } from "../src/repository-access.ts";
import type { OrchestratorInfo } from "../src/state.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("task repository grants come only from configuration and retained opened workspaces", () => {
	const entry = (
		id: number,
		extra: Partial<OrchestratorInfo>,
	): OrchestratorInfo => ({
		id,
		path: "/selected",
		title: "Project",
		profile: "test",
		createdAt: 0,
		...extra,
	});
	expect(
		taskRepositories(
			["/configured"],
			[
				entry(1, {}),
				entry(2, { path: "/worktree", repository: "/selected" }),
				entry(3, { path: "/retired", retiredAt: 1 }),
				entry(4, { path: "/configured" }),
			],
		),
	).toEqual(["/configured", "/selected"]);
	expect(taskRepositories([], [entry(1, { retiredAt: 1 })])).toEqual([]);
});

test("an explicitly opened custom checkout delegates nested tasks without editing configuration", async () => {
	let repository = "";
	const { app, config, fake, invocation, open } = await fixture(
		true,
		(config) => {
			repository = config.repositories[0];
			config.repositories = [];
			config.profiles.push({
				...config.profiles[0],
				id: "child",
				modelId: "replacement",
			});
		},
	);
	const input = { ...invocation, repository, workspace: "shared" as const };
	await expect(app.validateInvocation(input)).rejects.toThrow(
		"Repository is not authorized",
	);
	const directory = path.join(repository, "custom-directory");
	fs.mkdirSync(directory);
	const project = await app.orchestrators.create({
		path: directory,
		title: "Custom workspace",
	});
	expect(project.repository).toBe(repository);
	expect((await app.snapshot()).repositories).toContain(repository);
	await expect(
		app.validateInvocation({ ...input, repository: path.dirname(repository) }),
	).rejects.toThrow("Repository is not authorized");
	let rounds = 0;
	const reply: FauxResponseFactory = (_input, _options, _state, model) => {
		if (model.id === "replacement")
			return fauxAssistantMessage(fauxText("Child complete"));
		rounds++;
		return rounds === 1
			? fauxAssistantMessage(
					fauxToolCall("start_task", {
						...input,
						profile: "child",
						requestId: "custom-child",
					}),
					{ stopReason: "toolUse" },
				)
			: fauxAssistantMessage(fauxText("Parent complete"));
	};
	fake.setResponses(Array.from({ length: 8 }, () => reply));
	const id = await app.startTask(input, null, project.id);
	expect(
		(await app.harness.waitForTask(id as never, context)).state.outcome.status,
	).toBe("completed");
	const child = (await app.snapshot()).tasks.find((task) => task.parent === id);
	expect(child).toMatchObject({
		repository,
		workspace: directory,
		result: { status: "completed" },
	});
	expect(config.repositories).toEqual([]);
	await app.close();
	const restarted = await open();
	await expect(restarted.validateInvocation(input)).resolves.toMatchObject({
		repository,
	});
	await restarted.orchestrators.close(project.id);
	await expect(restarted.validateInvocation(input)).rejects.toThrow(
		"Repository is not authorized",
	);
	expect(config.repositories).toEqual([]);
});
