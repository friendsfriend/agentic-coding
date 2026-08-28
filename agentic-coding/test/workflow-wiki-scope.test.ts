import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..", "..");
const readRepositoryFile = (relativePath: string) =>
	fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

const instructionPaths = [
	"agent-definitions/instructions/planning.md",
	"agent-definitions/instructions/planning-fusion.md",
	"agent-definitions/instructions/fusion-consolidation.md",
	"agent-definitions/instructions/archive.md",
];

test("wiki guidance distinguishes project and shared knowledge", () => {
	const guidance = instructionPaths.map(readRepositoryFile);
	const specs = [
		readRepositoryFile(
			"openspec/changes/adjust-okf-wiki-structure/specs/knowledge-wiki/spec.md",
		),
		readRepositoryFile("openspec/specs/knowledge-wiki/spec.md"),
	];
	const readme = readRepositoryFile("README.md");

	for (const source of [...guidance, ...specs, readme]) {
		expect(source).toContain("projects/<project-id>/<concept>");
		expect(source).toContain("shared/<concept>");
		expect(source).toMatch(/repository-relative source path/i);
	}
	for (const source of [...guidance, ...specs]) {
		expect(source).toMatch(
			/evidence from every covered project|evidenced by every covered project|every project covered/i,
		);
		expect(source).toMatch(
			/update(?:s|d)? (?:an )?existing concepts? in place/i,
		);
		expect(source).toMatch(/active near-duplicates|active duplicate/i);
	}
	for (const source of [...guidance, ...specs, readme]) {
		expect(source).not.toMatch(
			/(?:each|one) repository(?:-specific)? bundle is required|one repository per (?:wiki )?bundle is the default|bundle belongs to one repository/i,
		);
	}

	expect(readme).toContain(
		"centralized bundle can contain knowledge from multiple projects",
	);
	expect(readme).not.toMatch(
		/(?:each|one) repository(?:-specific)? bundle is required/i,
	);
	expect(readme).not.toMatch(
		/one repository per (?:wiki )?bundle is the default/i,
	);
	expect(guidance[1]).toContain("Do not write wiki concepts");
	expect(guidance[1]).not.toContain("wiki write");
});

test("wiki scope requirements preserve the existing CLI and migration lifecycle", () => {
	const spec = readRepositoryFile(
		"openspec/changes/adjust-okf-wiki-structure/specs/knowledge-wiki/spec.md",
	);

	expect(spec).toMatch(/Scenario: CLI surface remains unchanged/);
	expect(spec).toContain("existing centralized bundle and CLI operations");
	expect(spec).toContain("without adding human or machine verification");
	expect(spec).toContain("repository/architecture");
	expect(spec).toContain("projects/agentic-coding/");
	expect(spec).toContain("status: draft");
	expect(spec).toContain("no `verified` event is added");
	expect(spec).toContain("status: deprecated");
});
