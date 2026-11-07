// Model-staged definition drafts: the tool stores inert bytes for later
// developer review and promotion, fenced by task ownership and revisions.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { digest } from "../src/config.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const valid = JSON.stringify({ version: 1, projects: [] });
const draftId = (requestId: string) => `draft-${digest(requestId)}`;

test("Model staging creates inert drafts the developer flow can promote", async () => {
	const { app, fake, invocation } = await fixture(false, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	let transcript = "";
	fake.setResponses([
		call("env_draft_stage", { requestId: "stage-valid", content: valid }),
		call("env_draft_stage", {
			requestId: "stage-broken",
			content: '{"version":1,"projects":',
		}),
		(messages) => {
			transcript = JSON.stringify(messages.messages);
			return fauxAssistantMessage("Staged for developer review");
		},
	]);
	const task = await app.startTask(invocation);
	await app.harness.waitForTask(task as TaskId, context);
	const listed = await app.environments.drafts.list();
	expect(listed).toHaveLength(2);
	const staged = await app.environments.drafts.read(draftId("stage-valid"));
	expect(staged.revision).toBe(1);
	expect(staged.digest).toBe(digest(valid));
	expect(typeof staged.stagedBy).toBe("number");
	expect(staged.schema.valid).toBe(true);
	const broken = await app.environments.drafts.read(draftId("stage-broken"));
	expect(broken.schema.valid).toBe(false);
	// Invalid text stays editable but inert: no live document, no promotion.
	expect(transcript).toContain("Staged bytes are inert");
	expect(await app.environments.drafts.promotions()).toHaveLength(0);
}, 30000);

test("Model revisions need ownership and exact revisions with idempotent request IDs", async () => {
	const { app, fake, invocation } = await fixture(false, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const revised = JSON.stringify({
		version: 1,
		projects: [{ id: "api", kind: "app", repository: "x", targets: [] }],
	});
	// A developer-staged draft shares the namespace; the model must not touch it.
	const developer = await app.environments.drafts.save({
		requestId: "developer-draft",
		content: valid,
	});
	let transcript = "";
	fake.setResponses([
		call("env_draft_stage", { requestId: "own-first", content: valid }),
		call("env_draft_stage", {
			requestId: "own-second",
			content: revised,
			id: draftId("own-first"),
			revision: 1,
		}),
		// Exact-input retry of the revision returns the recorded receipt.
		call("env_draft_stage", {
			requestId: "own-second",
			content: revised,
			id: draftId("own-first"),
			revision: 1,
		}),
		// Stale revision, foreign drafts and reused IDs for new content refuse.
		call("env_draft_stage", {
			requestId: "own-stale",
			content: revised,
			id: draftId("own-first"),
			revision: 1,
		}),
		call("env_draft_stage", {
			requestId: "own-foreign",
			content: revised,
			id: developer.id,
			revision: 1,
		}),
		call("env_draft_stage", {
			requestId: "own-second",
			content: valid,
			id: draftId("own-first"),
			revision: 2,
		}),
		(messages) => {
			transcript = JSON.stringify(messages.messages);
			return fauxAssistantMessage("Revision fences hold");
		},
	]);
	const task = await app.startTask(invocation);
	await app.harness.waitForTask(task as TaskId, context);
	expect(transcript).toContain("Draft revision conflict");
	expect(transcript).toContain("may revise only their own staged drafts");
	expect(transcript).toContain("reused for different content or revision");
	const staged = await app.environments.drafts.read(draftId("own-first"));
	expect(staged.revision).toBe(2);
	expect(staged.digest).toBe(digest(revised));
	const untouched = await app.environments.drafts.read(developer.id);
	expect(untouched.revision).toBe(1);
	expect(untouched.content).toBe(valid);
}, 30000);

test("Task draft capacity and cross-task isolation", async () => {
	const { app, fake, invocation } = await fixture(false, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const calls = [];
	for (let index = 0; index < 9; index++)
		calls.push(
			call("env_draft_stage", {
				requestId: `cap-${index}`,
				content: valid,
			}),
		);
	let transcript = "";
	fake.setResponses([
		...calls,
		(messages) => {
			transcript = JSON.stringify(messages.messages);
			return fauxAssistantMessage("Capacity holds");
		},
	]);
	const first = await app.startTask(invocation);
	await app.harness.waitForTask(first as TaskId, context);
	expect(transcript).toContain("Native task draft capacity reached");
	expect(await app.environments.drafts.list()).toHaveLength(8);
	// A second task cannot revise the first task's drafts.
	let secondTranscript = "";
	fake.setResponses([
		call("env_draft_stage", {
			requestId: "second-foreign",
			content: valid,
			id: draftId("cap-0"),
			revision: 1,
		}),
		(messages) => {
			secondTranscript = JSON.stringify(messages.messages);
			return fauxAssistantMessage("Isolation holds");
		},
	]);
	const second = await app.startTask({ ...invocation, requestId: "task-2" });
	await app.harness.waitForTask(second as TaskId, context);
	expect(secondTranscript).toContain("may revise only their own staged drafts");
	expect((await app.environments.drafts.read(draftId("cap-0"))).revision).toBe(
		1,
	);
}, 60000);
