import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import wikiSkill from "../skills/wiki-comment/SKILL.md" with { type: "text" };
import { digest } from "../src/config.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("native wiki saves exact revision-fenced snapshots and binds one read-only comment task durably", async () => {
	const { app, config, fake, open } = await fixture(true, (config) =>
		config.skills.push({
			id: "wiki-comment",
			description: "Comment review",
			origin: "system",
			readOnly: true,
			content: wikiSkill,
			digest: digest(wikiSkill),
		}),
	);
	const host = serve(app),
		client = new ClientConnection(host.client);
	let taskId = -1;
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		expect(await client.call("wiki.list", {})).toEqual([]);
		const exactContent = `# Guide\r\n${Array.from({ length: 360 }, (_, index) => `Line ${index}: supplied 🧭 text\r\n`).join("")}\nTrailing blank line\n\n`;
		const page = {
			id: "guide",
			title: "Guide",
			content: exactContent,
			baseRevision: 0,
		};
		const candidate = await client.call("wiki.preview", page);
		expect(candidate.snapshot).toBe(JSON.stringify(page, null, 2));
		expect(await client.call("wiki.list", {})).toEqual([]);
		await expect(
			client.call("wiki.apply", {
				id: candidate.id,
				approval: "approve:wrong",
			}),
		).rejects.toThrow();
		await expect(
			client.call("wiki.preview", { ...page, id: "../../README.md" }),
		).rejects.toThrow();
		const extraPreview = { ...page, credential: "not-allowed" };
		await expect(client.call("wiki.preview", extraPreview)).rejects.toThrow();
		const saved = await client.call("wiki.apply", {
			id: candidate.id,
			approval: `approve:${candidate.digest}`,
		});
		expect((await client.call("wiki.read", { id: "guide" })).page.content).toBe(
			exactContent,
		);
		expect((await client.call("wiki.read", { id: "guide" })).page.digest).toBe(
			digest(exactContent),
		);
		expect(saved).toMatchObject({
			id: "guide",
			revision: 1,
			content: page.content,
			digest: digest(page.content),
		});
		await expect(
			client.call("wiki.apply", {
				id: candidate.id,
				approval: `approve:${candidate.digest}`,
			}),
		).rejects.toThrow();
		const stale = await client.call("wiki.preview", {
			...page,
			content: "Stale",
			baseRevision: 1,
		});
		const fresh = await client.call("wiki.preview", {
			...page,
			content: "New content",
			baseRevision: 1,
		});
		await client.call("wiki.apply", {
			id: fresh.id,
			approval: `approve:${fresh.digest}`,
		});
		await expect(
			client.call("wiki.apply", {
				id: stale.id,
				approval: `approve:${stale.digest}`,
			}),
		).rejects.toThrow();
		const comment = {
			pageId: "guide",
			pageRevision: 2,
			comment: "Please clarify this guide",
			profile: "test",
			repository: config.repositories[0] ?? "",
			baseRef: "HEAD",
			requestId: "comment-1",
		};
		await expect(
			client.call("wiki.comment", { ...comment, pageRevision: 1 }),
		).rejects.toThrow();
		const extraComment = { ...comment, policy: "workspace-write" };
		await expect(client.call("wiki.comment", extraComment)).rejects.toThrow();
		expect((await client.call("state.read", {})).tasks).toEqual([]);
		fake.setResponses([
			fauxAssistantMessage(fauxText("Proposed replacement only")),
		]);
		const result = await client.call("wiki.comment", comment);
		taskId = result.taskId;
		expect(await client.call("wiki.comment", comment)).toEqual(result);
		await expect(
			client.call("wiki.comment", { ...comment, comment: "Different intent" }),
		).rejects.toThrow();
		const info = (await client.call("state.read", {})).tasks.find(
			(task) => task.id === taskId,
		);
		expect(info).toMatchObject({
			skill: "wiki-comment",
			policy: "read-only",
			topicId: "wiki-guide",
		});
		await eventually(
			async () => app.taskResult(taskId),
			(task) => task?.state.status === "terminal",
		);
		const document = await client.call("wiki.read", { id: "guide" });
		expect(document.page).toMatchObject({
			content: "New content",
			revision: 2,
		});
		expect(document.comments).toEqual([
			expect.objectContaining({
				id: "comment-1",
				pageId: "guide",
				pageRevision: 2,
				taskId,
			}),
		]);
		expect(document.comments[0]).not.toHaveProperty("invocation");
		expect(document.comments[0]).not.toHaveProperty("fingerprint");
		await expect(client.call("wiki.read", { id: "missing" })).rejects.toThrow();
	} finally {
		client.close();
		await host.stop();
	}
	await app.close();
	const reopened = await open();
	const document = await reopened.wiki.read("guide");
	expect(document.page).toMatchObject({ revision: 2, content: "New content" });
	expect(document.comments[0]).toMatchObject({ id: "comment-1", taskId });
	expect(
		await reopened.wiki.comment({
			pageId: "guide",
			pageRevision: 2,
			comment: "Please clarify this guide",
			profile: "test",
			repository: config.repositories[0] ?? "",
			baseRef: "HEAD",
			requestId: "comment-1",
		}),
	).toEqual({ taskId });
	expect((await reopened.snapshot()).tasks).toHaveLength(1);
});

test("direct operator wiki save is revision-fenced, private to the native doc and does not bypass candidate approval", async () => {
	const { app } = await fixture();
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		expect(await client.call("wiki.list", {})).toEqual([]);
		const page = {
			id: "ops-runbook",
			title: "Ops runbook",
			content: "# Runbook\n\nRestart the gateway.\n",
			baseRevision: 0,
		};
		const candidate = await client.call("wiki.preview", page);
		// An authenticated operator save needs no typed digest…
		const saved = await client.call("wiki.save", page);
		expect(saved).toMatchObject({
			id: "ops-runbook",
			title: "Ops runbook",
			revision: 1,
			content: page.content,
		});
		// …while the agent/HTTP candidate path still requires the exact approval.
		await expect(
			client.call("wiki.apply", {
				id: candidate.id,
				approval: "operator-click",
			}),
		).rejects.toThrow("Native operation refused");
		// A stale editor revision is refused rather than overwriting the save.
		await expect(client.call("wiki.save", page)).rejects.toThrow(
			"Native operation refused",
		);
		await expect(
			client.call("wiki.save", {
				...page,
				id: "../../README",
				baseRevision: 1,
			}),
		).rejects.toThrow("Native operation refused");
		await expect(
			client.call("wiki.save", {
				...page,
				content: "x".repeat(32001),
				baseRevision: 1,
			}),
		).rejects.toThrow("Native operation refused");
		const read = await client.call("wiki.read", { id: "ops-runbook" });
		expect(read.page.content).toBe(page.content);
		expect(read.page.revision).toBe(1);
		expect(await client.call("wiki.list", {})).toHaveLength(1);
		const updated = await client.call("wiki.save", {
			...page,
			title: "Ops runbook v2",
			content: "# Runbook\n\nRestart the gateway, then the worker.\n",
			baseRevision: 1,
		});
		expect(updated.revision).toBe(2);
		expect(
			(await client.call("wiki.read", { id: "ops-runbook" })).page.title,
		).toBe("Ops runbook v2");
	} finally {
		client.close();
		await host.stop();
		await app.close();
	}
});
