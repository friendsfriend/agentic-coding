import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { digest } from "../src/config.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("authenticated skill files retain the full Unicode/CRLF draft limit and consume directory-substituted attempts", async () => {
	const { app, config } = await fixture(false, (config) =>
		fs.mkdirSync(config.configDir, { mode: 0o700 }),
	);
	const host = serve(app),
		client = new ClientConnection(host.client),
		name = "unicode-draft",
		directory = path.join(config.configDir, "skills", name),
		file = path.join(directory, "SKILL.md"),
		loaded = structuredClone(config.skills);
	const head = `---\r\nname: ${name}\r\ndescription: Disposable exact source\r\n---\r\n\r\n`;
	const body = Array.from(
		{ length: 405 },
		(_, index) => `Line ${index}: 😀 e\u0301 ${"x".repeat(75)}\r\n`,
	).join("");
	const content = `${head}${body}${"z".repeat(64000 - head.length - body.length - 2)}\r\n`;
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const original = await client.call("skill-file.read", { name });
		expect(original.content).toBe("");
		expect(original.revision).toBe("missing");
		expect(content.length).toBe(64000);
		for (const invalid of [
			`${content}\n`,
			`${content.slice(0, -1)}\0`,
			`${content.slice(0, -1)}\ud800`,
		]) {
			await expect(
				client.call("skill-file.preview", {
					name,
					baseRevision: original.revision,
					content: invalid,
				}),
			).rejects.toThrow("Native operation refused");
		}
		const sealed = await client.call("skill-file.preview", {
			name,
			baseRevision: original.revision,
			content,
		});
		expect(sealed.content).toBe(content);
		expect(JSON.parse(sealed.snapshot).content).toBe(content);
		expect(sealed.digest).toBe(digest(sealed.snapshot));
		expect(fs.existsSync(directory)).toBe(false);
		await expect(
			client.call("skill-file.apply", {
				id: sealed.id,
				approval: `approve:${sealed.digest} `,
			}),
		).rejects.toThrow("Native operation refused");
		expect(fs.existsSync(file)).toBe(false);
		await client.call("skill-file.apply", {
			id: sealed.id,
			approval: `approve:${sealed.digest}`,
		});
		const observed = await client.call("skill-file.read", { name });
		expect(observed.content).toBe(content);
		expect(observed.revision).toBe(digest(Buffer.from(content)));
		expect(fs.readFileSync(file).equals(Buffer.from(content))).toBe(true);
		const alias = path.join(config.configDir, "hard-linked-fixture.md");
		fs.linkSync(file, alias);
		await expect(client.call("skill-file.read", { name })).rejects.toThrow(
			"Native operation refused",
		);
		fs.unlinkSync(alias);
		const pending = await client.call("skill-file.preview", {
			name,
			baseRevision: observed.revision,
			content: content.slice(0, -2),
		});
		const retained = `${directory}-old`;
		fs.renameSync(directory, retained);
		fs.mkdirSync(directory);
		fs.writeFileSync(file, content);
		await expect(
			client.call("skill-file.apply", {
				id: pending.id,
				approval: `approve:${pending.digest}`,
			}),
		).rejects.toThrow("Native operation refused");
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		fs.rmSync(directory, { recursive: true });
		fs.renameSync(retained, directory);
		// Restoring the exact old file and directory cannot resurrect a consumed attempt.
		await expect(
			client.call("skill-file.apply", {
				id: pending.id,
				approval: `approve:${pending.digest}`,
			}),
		).rejects.toThrow("Native operation refused");
		expect((await client.call("skill-file.read", { name })).content).toBe(
			content,
		);
		expect(config.skills).toEqual(loaded);
		expect((await client.call("state.read", {})).tasks).toEqual([]);
	} finally {
		client.close();
		await host.stop();
	}
});

test("authenticated skill authoring is inert until exact confirmation, stale/destination-fenced and never reloads live skills", async () => {
	const { app, config } = await fixture(false, (config) =>
		fs.mkdirSync(config.configDir, { mode: 0o700 }),
	);
	const host = serve(app),
		client = new ClientConnection(host.client),
		name = "local-check",
		file = path.join(config.configDir, "skills", name, "SKILL.md"),
		loaded = structuredClone(config.skills);
	const content = `---\nname: ${name}\ndescription: Disposable user instruction\n---\n\nRead the README without changing it.\n`;
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const original = await client.call("skill-file.read", { name });
		expect(original.revision).toBe("missing");
		const candidate = await client.call("skill-file.preview", {
			name,
			baseRevision: original.revision,
			content,
		});
		expect(candidate.digest).toBe(digest(candidate.snapshot));
		expect(fs.existsSync(path.dirname(file))).toBe(false);
		await expect(
			client.call("skill-file.apply", {
				id: candidate.id,
				approval: "approve:wrong",
			}),
		).rejects.toThrow("Native operation refused");
		expect(fs.existsSync(file)).toBe(false);
		const saved = await client.call("skill-file.apply", {
			id: candidate.id,
			approval: `approve:${candidate.digest}`,
		});
		expect(saved.revision).toBe(digest(content));
		expect(fs.readFileSync(file, "utf8")).toBe(content);
		expect(config.skills).toEqual(loaded);
		expect((await client.call("state.read", {})).tasks).toEqual([]);
		await expect(
			client.call("skill-file.apply", {
				id: candidate.id,
				approval: `approve:${candidate.digest}`,
			}),
		).rejects.toThrow("Native operation refused");
		const current = await client.call("skill-file.read", { name });
		const stale = await client.call("skill-file.preview", {
			name,
			baseRevision: current.revision,
			content: `${content}\nIntended edit.\n`,
		});
		fs.writeFileSync(file, `${content}\nExternal edit.\n`);
		await expect(
			client.call("skill-file.apply", {
				id: stale.id,
				approval: `approve:${stale.digest}`,
			}),
		).rejects.toThrow("Native operation refused");
		expect(fs.readFileSync(file, "utf8")).toContain("External edit.");
		const outside = path.join(config.configDir, "outside.md");
		fs.renameSync(file, outside);
		fs.symlinkSync(outside, file);
		await expect(client.call("skill-file.read", { name })).rejects.toThrow(
			"Native operation refused",
		);
		await expect(
			client.call("skill-file.read", { name: "../outside" }),
		).rejects.toThrow("Native operation refused");
		await expect(
			client.call("skill-file.read", { name: "code" }),
		).rejects.toThrow("Native operation refused");
		expect(fs.readFileSync(outside, "utf8")).toContain("External edit.");
	} finally {
		client.close();
		await host.stop();
	}
});
