import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.ts";
import { sessionCatalog } from "../src/server/client/handlers/sessions.ts";
import { Catalog, decode, type Schedule, type TaskInfo } from "../src/state.ts";
import { dismissTasks, taskSubtree } from "../src/task-retention.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, definition, cleanup, apps } = createFixtures();
afterEach(cleanup);

test("cleanup follows recursive task ownership, not related work or independent conversations", () => {
	const task = (id: number, extra: Partial<TaskInfo>) =>
		({ id, ...extra }) as TaskInfo;
	const infos = [
		task(1, { admittedBy: 100, conversationId: 101 }),
		task(2, { parent: 1, admittedBy: 101, conversationId: 102 }),
		task(3, { admittedBy: 102 }),
		task(4, { admittedBy: 200, relatedTo: 1 }),
	];
	expect([...taskSubtree(infos, { conversation: 100 })]).toEqual([1, 2, 3]);
	expect([...taskSubtree(infos, { task: 2 })]).toEqual([2, 3]);
	expect([
		...taskSubtree([...infos, task(5, { parent: 6 }), task(6, { parent: 5 })], {
			task: 5,
		}),
	]).toEqual([5, 6]);
});

test("dismissed nested tasks stay gone after restart while conversations and native outcomes survive", async () => {
	const { app, config, fake, invocation, open } = await fixture(
		true,
		(config) => {
			config.profiles.push({
				...config.profiles[0],
				id: "child",
				modelId: "replacement",
			});
		},
	);
	const orchestrator = await app.orchestrators.create({
		path: config.repositories[0],
		title: "Keep me",
	});
	let rounds = 0;
	const reply: FauxResponseFactory = (_input, _options, _state, model) => {
		if (model.id === "replacement")
			return fauxAssistantMessage(fauxText("Child complete"));
		rounds++;
		return rounds === 1
			? fauxAssistantMessage(
					fauxToolCall("start_task", {
						...invocation,
						workspace: "shared",
						profile: "child",
						requestId: "owned-child",
					}),
					{ stopReason: "toolUse" },
				)
			: fauxAssistantMessage(fauxText("Parent complete"));
	};
	fake.setResponses(Array.from({ length: 8 }, () => reply));
	const input = { ...invocation, workspace: "shared" as const };
	const id = await app.startTask(input, null, orchestrator.id);
	await app.harness.waitForTask(id as never, context);
	const child = (await app.snapshot()).tasks.find((task) => task.parent === id);
	if (!child?.conversationId) throw new Error("Missing nested conversation");
	expect(await dismissTasks(app, id)).toEqual({ removed: 2, keptActive: 0 });
	expect((await app.snapshot()).tasks).toHaveLength(0);
	expect((await sessionCatalog(app)).map((row) => row.id)).toEqual([
		Number(app.home.id),
		orchestrator.id,
	]);
	expect((await app.taskResult(child.id))?.state.status).toBe("terminal");
	expect(await app.startTask(input, null, orchestrator.id)).toBe(id);
	await expect(
		app.startTask(
			{ ...invocation, requestId: "late-child" },
			null,
			child.conversationId,
		),
	).rejects.toThrow("Task was removed");
	expect(await dismissTasks(app, id)).toEqual({ removed: 0, keptActive: 0 });
	await app.close();
	const restarted = await open();
	expect((await restarted.snapshot()).tasks).toHaveLength(0);
	expect((await sessionCatalog(restarted)).map((row) => row.id)).toContain(
		orchestrator.id,
	);
	expect((await restarted.taskResult(id))?.state.status).toBe("terminal");
});

test("bulk maintenance skips active tasks; close fences admission and cleans only its own work", async () => {
	const { config, models, fake } = await definition();
	const app = await Runtime.open(config, models, new MemoryStorage(), {
		resume: false,
	});
	apps.push(app);
	const orchestrator = await app.orchestrators.create({
		path: config.repositories[0],
		title: "Close me",
	});
	const independent = await app.orchestrators.create({
		path: config.repositories[0],
		title: "Keep me",
		spawnedBy: orchestrator.id,
	});
	const input = {
		workspace: "worktree" as const,
		topicId: "cleanup",
		repository: config.repositories[0],
		skill: "code",
		profile: "test",
		inputs: "Do not run",
		requestId: "owned",
	};
	await app.scheduler.create(
		input,
		{ kind: "once", at: Date.now() + 86400000 },
		null,
		"owned-schedule",
		orchestrator.id,
	);
	await app.scheduler.create(
		input,
		{ kind: "once", at: Date.now() + 86400000 },
		null,
		"independent-schedule",
		independent.id,
	);
	const owned = await app.startTask(input, null, orchestrator.id);
	const kept = await app.startTask(
		{ ...input, requestId: "kept" },
		null,
		independent.id,
	);
	expect(await dismissTasks(app)).toEqual({ removed: 0, keptActive: 2 });
	await expect(dismissTasks(app, owned)).rejects.toThrow("active work");
	expect(fake.state.callCount).toBe(0);
	// Keep this independent fixture from executing when conversation.abort
	// enables native scheduling. Maintenance itself must never enable it.
	await app.harness.abortTask(kept as never, context);
	await app.orchestrators.close(orchestrator.id);
	expect((await app.snapshot()).tasks.map((task) => task.id)).toEqual([kept]);
	expect((await app.orchestrators.read()).map((entry) => entry.id)).toContain(
		independent.id,
	);
	await expect(
		app.startTask(
			{ ...input, requestId: "after-close" },
			null,
			orchestrator.id,
		),
	).rejects.toThrow("Orchestrator is closed");
	const catalog = await app.harness.snapshot(Catalog, context);
	expect(
		decode<Schedule>(catalog?.schedules["owned-schedule"] ?? "{}"),
	).toMatchObject({ state: "paused", revision: 2 });
	expect(
		decode<Schedule>(catalog?.schedules["independent-schedule"] ?? "{}"),
	).toMatchObject({ state: "enabled", revision: 1 });
	// Native abort APIs enable scheduling; unrelated work remains independently owned.
	app.harness.resume();
	expect(
		(await app.harness.waitForTask(owned as never, context)).state.status,
	).toBe("terminal");
	expect(
		(await app.harness.waitForTask(kept as never, context)).state.outcome
			.status,
	).toBe("aborted");
	expect(
		(await app.harness.snapshot(Catalog, context))?.tasks[String(owned)],
	).toContain("dismissedAt");
});
