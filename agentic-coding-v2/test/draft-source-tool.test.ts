// Model-staged source files: one task-owned draft gains its declared Compose
// file and auxiliary bytes through the tool, fenced by ownership, exact
// revisions and the declared-binding constraint.
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
const draftId = (requestId: string) => `draft-${digest(requestId)}`;
const composeYaml = `services:\n  web:\n    image: example.invalid/web:1\n`;
const composeDoc = (repository: string) =>
	JSON.stringify({
		version: 1,
		projects: [
			{
				id: "api",
				kind: "app",
				repository,
				targets: [
					{
						id: "web",
						action: "run",
						runtime: "compose",
						compose: {
							file: "compose.yml",
							provider: "docker",
							socket: "/tmp/fixture.sock",
						},
					},
				],
			},
		],
	});
const layout = (config: { stateDir: string; configDir: string }) => {
	fs.chmodSync(config.stateDir, 0o700);
	fs.mkdirSync(config.configDir, { mode: 0o700 });
};

test("Model stages declared Compose and auxiliary sources onto its own draft", async () => {
	const { app, config, fake, invocation } = await fixture(false, layout);
	const id = draftId("src-doc");
	const developer = await app.environments.drafts.save({
		requestId: "src-developer",
		content: composeDoc(config.repositories[0]),
	});
	let transcript = "";
	fake.setResponses([
		call("env_draft_stage", {
			requestId: "src-doc",
			content: composeDoc(config.repositories[0]),
		}),
		call("env_draft_source", {
			requestId: "src-compose",
			id,
			revision: 1,
			app: "api",
			target: "web",
			content: composeYaml,
		}),
		call("env_draft_source", {
			requestId: "src-aux",
			id,
			revision: 2,
			app: "api",
			target: "web",
			content: "READY=1\n",
			auxiliary: true,
			file: "config/extra.env",
		}),
		// Foreign and stale revisions refuse without touching either draft.
		call("env_draft_source", {
			requestId: "src-foreign",
			id: developer.id,
			revision: 1,
			app: "api",
			target: "web",
			content: composeYaml,
		}),
		call("env_draft_source", {
			requestId: "src-stale",
			id,
			revision: 2,
			app: "api",
			target: "web",
			content: composeYaml,
		}),
		(messages) => {
			transcript = JSON.stringify(messages.messages);
			return fauxAssistantMessage("Sources staged for developer review");
		},
	]);
	const task = await app.startTask(invocation);
	await app.harness.waitForTask(task as TaskId, context);
	expect(transcript).toContain("only onto their own staged drafts");
	expect(transcript).toContain("Draft revision conflict");
	const staged = await app.environments.drafts.read(id);
	expect(staged.revision).toBe(3);
	expect(staged.sources?.map((source) => source.file).sort()).toEqual([
		"compose.yml",
		"config/extra.env",
	]);
	expect(
		staged.sources?.find((source) => source.file === "compose.yml")?.digest,
	).toBe(digest(composeYaml));
	const untouched = await app.environments.drafts.read(developer.id);
	expect(untouched.revision).toBe(1);
	expect(untouched.sources).toBeUndefined();
	expect(await app.environments.drafts.promotions()).toHaveLength(0);
}, 30000);

test("Auxiliary sources require the declared Compose file and an exact declared target", async () => {
	const { app, config, fake, invocation } = await fixture(false, layout);
	const id = draftId("order-doc");
	let transcript = "";
	fake.setResponses([
		call("env_draft_stage", {
			requestId: "order-doc",
			content: composeDoc(config.repositories[0]),
		}),
		call("env_draft_source", {
			requestId: "order-aux-first",
			id,
			revision: 1,
			app: "api",
			target: "web",
			content: "READY=1\n",
			auxiliary: true,
			file: "config/extra.env",
		}),
		call("env_draft_source", {
			requestId: "order-unknown",
			id,
			revision: 1,
			app: "nope",
			target: "web",
			content: composeYaml,
		}),
		(messages) => {
			transcript = JSON.stringify(messages.messages);
			return fauxAssistantMessage("Declared-first fence holds");
		},
	]);
	const task = await app.startTask(invocation);
	await app.harness.waitForTask(task as TaskId, context);
	expect(transcript).toContain("Stage the target's declared Compose file");
	expect(transcript).toContain("exact conventional public Compose target");
	const staged = await app.environments.drafts.read(id);
	expect(staged.revision).toBe(1);
	expect(staged.sources).toBeUndefined();
}, 30000);
