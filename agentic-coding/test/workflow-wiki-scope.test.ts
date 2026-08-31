import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AGENT_DEFINITIONS } from "../src/workflow/embedded.generated.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..", "..");
const readRepositoryFile = (relativePath: string) =>
	fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

const planningInstructionPaths = [
	"agent-definitions/instructions/planning.md",
	"agent-definitions/instructions/planning-fusion.md",
	"agent-definitions/instructions/fusion-consolidation.md",
];
const wikiInstructionPath = "agent-definitions/instructions/wiki.md";

test("wiki guidance distinguishes project and shared knowledge", () => {
	const guidance = planningInstructionPaths.map(readRepositoryFile);
	const wiki = readRepositoryFile(wikiInstructionPath);
	const archive = readRepositoryFile(
		"agent-definitions/instructions/archive.md",
	);
	expect(AGENT_DEFINITIONS["instructions/wiki.md"]).toBe(wiki);
	expect(AGENT_DEFINITIONS["instructions/archive.md"]).toBe(archive);
	const specs = [readRepositoryFile("openspec/specs/knowledge-wiki/spec.md")];
	const readme = readRepositoryFile("README.md");

	for (const source of [...guidance, wiki, ...specs, readme]) {
		expect(source).toContain("projects/<project-id>/<concept>");
		expect(source).toContain("shared/<concept>");
		expect(source).toMatch(/repository-relative source path/i);
	}
	for (const source of [...guidance, wiki, ...specs]) {
		expect(source).toMatch(
			/evidence from every covered project|evidence from each covered project|evidenced by every covered project|every project covered/i,
		);
		expect(source).toMatch(
			/update(?:s|d)? (?:an )?existing concepts? in place|updates that identifier/i,
		);
		expect(source).toMatch(/active near-duplicates?|active duplicate/i);
	}
	for (const source of [...guidance, wiki, ...specs, readme]) {
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
	for (const source of guidance)
		expect(source).toContain("Do not write wiki concepts");
	expect(wiki).toContain("OKF v0.2");
	expect(wiki).toContain("review comments");
	expect(wiki).toContain("agentic-coding workflow wiki write");
	expect(wiki).toContain("no durable knowledge found");
	expect(wiki).toContain("status: draft");
	expect(archive).not.toMatch(/wiki/i);
});

test("wiki guidance updates existing concepts before creating", () => {
	const wiki = readRepositoryFile(wikiInstructionPath);
	const embedded = AGENT_DEFINITIONS["instructions/wiki.md"];

	expect(embedded).toBe(wiki);
	expect(wiki).toMatch(
		/1\.\s+Search the centralized bundle with multiple related terms/i,
	);
	expect(wiki).toMatch(
		/2\.\s+Inspect every plausible candidate with `agentic-coding workflow wiki show <concept-id>`/i,
	);
	expect(wiki).toMatch(
		/3\.\s+When a candidate covers the intended subject, select its canonical existing concept identifier and update that concept in place/i,
	);
	expect(wiki).toMatch(
		/4\.\s+Create a new project-scoped concept only when no candidate is the intended subject or when the requested knowledge is materially distinct from every candidate/i,
	);
	expect(wiki).toMatch(
		/run-bound evidence must name the searches and candidates considered and explain why updating an existing candidate would be incorrect/i,
	);
	expect(wiki).toMatch(
		/preserve the existing concept identifier, unrelated body content, unknown frontmatter fields, and applicable provenance and lifecycle metadata/i,
	);
	expect(wiki).toMatch(
		/For every new concept, also report the evidence-backed reason that no existing concept could be updated or that the knowledge is materially distinct/i,
	);
});

test("wiki scope requirements preserve the existing CLI and migration lifecycle", () => {
	const spec = readRepositoryFile("openspec/specs/knowledge-wiki/spec.md");
	const changeSpec = readRepositoryFile(
		"openspec/changes/archive/2026-08-29-use-a-wiki-agent-for-documentation/specs/knowledge-wiki/spec.md",
	);

	expect(spec).toMatch(/Scenario: CLI surface remains unchanged/);
	expect(spec).toContain("existing centralized bundle and CLI operations");
	expect(spec).toContain("without adding human or machine verification");
	expect(spec).toContain("repository/architecture");
	expect(spec).toContain("projects/agentic-coding/");
	expect(spec).toContain("status: draft");
	expect(spec).toContain("no `verified` event is added");
	expect(spec).toContain("status: deprecated");
	expect(changeSpec).toContain(
		"administrative `wiki verify` operation MAY set `status: stable`",
	);
	expect(changeSpec).toContain("process:herdr-archive");
	expect(changeSpec).toContain("human-reviewed trust");
});
