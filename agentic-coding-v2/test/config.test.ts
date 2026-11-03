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
test("independent config exposes all profiles and packaged skills without loading legacy machinery", () => {
	const root = fixture({
		profiles: {
			small: { model: "local/small", thinking: "off" },
			large: { model: "company/vendor/model", thinking: "high" },
		},
		orchestratorProfile: "large",
		repositories: [],
		profileSource: "/does/not/exist",
	});
	const config = loadConfig(root, root);
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
	const config = loadConfig(root, root);
	expect(config.orchestratorProfile).toBe("chosen");
	expect(config).not.toHaveProperty("presets");
	expect(config).not.toHaveProperty("schedules");
});
test("malformed configuration fails visibly without leaking values or silently broadening repository scope", () => {
	const root = fixture({ profiles: {}, repositories: "wrong" });
	expect(() => loadConfig(root, root)).toThrow("repositories must be an array");
	fs.writeFileSync(path.join(root, "config.json"), "{ secret-value");
	try {
		loadConfig(root, root);
		throw new Error("Expected invalid config");
	} catch (error) {
		expect(String(error)).toContain(root);
		expect(String(error)).not.toContain("secret-value");
	}
});
