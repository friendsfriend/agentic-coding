import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { digest } from "../src/config.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
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
