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
// One self-contained brief per wiki role: the shared `wiki.md` contract is
// folded into each, so both files carry the contract and their own approach.
const wikiRoleInstructionPaths = [
	"agent-definitions/instructions/wiki-openspec.md",
	"agent-definitions/instructions/wiki-research.md",
];

test("wiki guidance distinguishes project and shared knowledge", () => {
	const guidance = planningInstructionPaths.map(readRepositoryFile);
	const wikis = wikiRoleInstructionPaths.map(readRepositoryFile);
	const archive = readRepositoryFile(
		"agent-definitions/instructions/archive.md",
	);
	for (const wikiPath of wikiRoleInstructionPaths) {
		expect(AGENT_DEFINITIONS[wikiPath.replace("agent-definitions/", "")]).toBe(
			readRepositoryFile(wikiPath),
		);
	}
	expect(AGENT_DEFINITIONS["instructions/archive.md"]).toBe(archive);
	const specs = [readRepositoryFile("openspec/specs/knowledge-wiki/spec.md")];
	const readme = readRepositoryFile("README.md");

	for (const source of [...guidance, ...wikis, ...specs, readme]) {
		expect(source).toContain("projects/<project-id>/<concept>");
		expect(source).toContain("shared/<concept>");
		expect(source).toMatch(/repository-relative source path/i);
	}
	for (const source of [...guidance, ...wikis, ...specs]) {
		expect(source).toMatch(
			/evidence from every covered project|evidence from each covered project|evidenced by every covered project|every project covered/i,
		);
		expect(source).toMatch(
			/update(?:s|d)? (?:an )?existing concepts? in place|updates that identifier/i,
		);
		expect(source).toMatch(/active near-duplicates?|active duplicate/i);
	}
	for (const source of [...guidance, ...wikis, ...specs, readme]) {
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
	for (const wiki of wikis) {
		expect(wiki).toContain("OKF v0.2");
		expect(wiki).toContain("review comments");
		expect(wiki).toContain("agentic-coding workflow wiki write");
		expect(wiki).toContain("no durable knowledge found");
		expect(wiki).toContain("status: draft");
	}
	expect(archive).not.toMatch(/wiki/i);
});

test("wiki guidance updates existing concepts before creating", () => {
	for (const wikiPath of wikiRoleInstructionPaths) {
		const wiki = readRepositoryFile(wikiPath);
		const embedded =
			AGENT_DEFINITIONS[wikiPath.replace("agent-definitions/", "")];

		expect(embedded).toBe(wiki);
		expect(wiki).toMatch(/1\.\s+Search the bundle with several related terms/i);
		expect(wiki).toMatch(
			/2\.\s+Inspect every plausible candidate with `agentic-coding workflow wiki show <concept-id>`/i,
		);
		expect(wiki).toMatch(
			/3\.\s+When a candidate covers the subject, update an existing concept in place/i,
		);
		expect(wiki).toMatch(
			/4\.\s+Create a new project-scoped concept only when no candidate is the subject or the knowledge is materially distinct/i,
		);
		expect(wiki).toMatch(
			/name the searches and candidates considered and why updating one would be wrong/i,
		);
		expect(wiki).toMatch(
			/preserving its identifier, unrelated body, unknown frontmatter and provenance/i,
		);
		expect(wiki).toMatch(
			/for each new concept, the evidence-backed reason that no existing concept could be updated or that the knowledge is materially distinct/i,
		);
	}
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
