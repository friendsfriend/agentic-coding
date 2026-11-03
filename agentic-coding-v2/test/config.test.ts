import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { force: true, recursive: true });
});
function fixture(data: unknown) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-config-"));
	roots.push(root);
	fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(data));
	return root;
}
test("standalone application embeds system skills and discovers user skills only in its config directory", async () => {
	const root = fixture({
		profiles: {
			small: { model: "local/small", thinking: "off" },
			large: { model: "company/vendor/model", thinking: "high" },
		},
		orchestratorProfile: "large",
		repositories: [],
		profileSource: "/does/not/exist",
	});
	fs.mkdirSync(path.join(root, "state"));
	fs.writeFileSync(path.join(root, "state/config.json"), "not configuration");
	const config = loadConfig(path.join(root, "state"), root, root);
	expect(config.configDir).toBe(root);
	expect(config.skills.every((skill) => skill.origin === "system")).toBe(true);
	expect(config.profiles.map((profile) => profile.id)).toEqual([
		"small",
		"large",
	]);
	expect(config.profiles[1].modelId).toBe("vendor/model");
	expect(config.orchestratorProfile).toBe("large");
	expect(config.repositories).toEqual([]);
	expect(config.skills.map((skill) => skill.id).sort()).toEqual([
		"code",
		"research",
	]);
	const standalone = path.join(root, "standalone");
	const build = await Bun.build({
		entrypoints: [path.resolve(import.meta.dir, "../src/config.ts")],
		target: "bun",
		outdir: standalone,
	});
	if (!build.success)
		throw new Error(`Standalone skill bundle failed: ${build.logs.join("\n")}`);
	const bundled = (await import(
		path.join(standalone, "config.js")
	)) as typeof import("../src/config.ts");
	expect(bundled.loadConfig(config.stateDir, root, root).skills).toEqual(
		config.skills,
	);
	const userDir = path.join(root, "skills/notes");
	fs.mkdirSync(userDir, { recursive: true });
	const file = path.join(userDir, "SKILL.md");
	const initial =
		"---\nname: notes\ndescription: Summarize local project notes.\n---\nUse the project's notes.\n";
	fs.writeFileSync(file, initial);
	const first = bundled
		.loadConfig(config.stateDir, root, root)
		.skills.find((skill) => skill.id === "notes");
	expect(first?.origin).toBe("user");
	expect(first?.content).toBe(initial);
	fs.writeFileSync(file, `${initial}\nNew instructions.\n`);
	const updated = bundled
		.loadConfig(config.stateDir, root, root)
		.skills.find((skill) => skill.id === "notes");
	expect(updated?.digest).not.toBe(first?.digest);
	expect(first?.content).toBe(initial);
	const duplicate = path.join(root, "skills/code");
	fs.mkdirSync(duplicate);
	fs.writeFileSync(
		path.join(duplicate, "SKILL.md"),
		"---\nname: code\ndescription: Attempt to replace the system skill.\n---\nReplacement\n",
	);
	expect(() => bundled.loadConfig(config.stateDir, root, root)).toThrow(
		"Duplicate skill: code",
	);
});
test("explicit legacy profile import reads no presets or schedules", () => {
	const root = fixture({ profiles: {} });
	const source = path.join(root, "legacy.json");
	fs.writeFileSync(
		source,
		JSON.stringify({
			agents: {
				default_profile: "chosen",
				profiles: { chosen: { model: "fake/model" } },
				presets: { unwanted: true },
			},
			schedules: ["not imported"],
		}),
	);
	fs.writeFileSync(
		path.join(root, "config.json"),
		JSON.stringify({ profileSource: source, repositories: [] }),
	);
	const config = loadConfig(path.join(root, "state"), root, root);
	expect(config.orchestratorProfile).toBe("chosen");
	expect(config).not.toHaveProperty("presets");
	expect(config).not.toHaveProperty("schedules");
});
test("malformed configuration fails visibly without leaking values or silently broadening repository scope", () => {
	const root = fixture({ profiles: {}, repositories: "wrong" });
	expect(() => loadConfig(path.join(root, "state"), root, root)).toThrow(
		"repositories must be an array",
	);
	fs.writeFileSync(path.join(root, "config.json"), "{ secret-value");
	try {
		loadConfig(path.join(root, "state"), root, root);
		throw new Error("Expected invalid config");
	} catch (error) {
		expect(String(error)).toContain(root);
		expect(String(error)).not.toContain("secret-value");
	}
});
