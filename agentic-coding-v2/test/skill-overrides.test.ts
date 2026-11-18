import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digest, loadConfig } from "../src/config.ts";

test("an installed user skill overrides a newly bundled default without changing user files", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-skill-override-"));
	try {
		fs.writeFileSync(
			path.join(root, "config.json"),
			JSON.stringify({ profiles: {} }),
		);
		const directory = path.join(root, "skills", "openspec-apply-change");
		fs.mkdirSync(directory, { recursive: true });
		const file = path.join(directory, "SKILL.md");
		const content =
			"---\nname: openspec-apply-change\ndescription: My installed OpenSpec skill\n---\n\nUse my customized apply instructions.\n";
		fs.writeFileSync(file, content);
		const config = loadConfig(path.join(root, "state"), root, root);
		const matches = config.skills.filter(
			(skill) => skill.id === "openspec-apply-change",
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]).toMatchObject({
			origin: "user",
			content,
			digest: digest(content),
			sourceFile: fs.realpathSync(file),
		});
		expect(
			config.skills.some(
				(skill) =>
					skill.id === "openspec-workflow" && skill.origin === "system",
			),
		).toBe(true);
		expect(fs.readFileSync(file, "utf8")).toBe(content);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
