import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run as runWorkflow } from "../src/workflow/cli.ts";
import {
	appendLog,
	checkConformance,
	citationReport,
	conceptPath,
	effectiveStatus,
	ensureBundle,
	isStale,
	listConcepts,
	parseDocument,
	readConcept,
	renderDocument,
	STALE_AFTER_DAYS,
	searchConcepts,
	snapshotList,
	snapshotOnFirstTouch,
	snapshotRead,
	trustTier,
	verifyConcept,
	writeConcept,
} from "../src/workflow/wiki.ts";

let root = "";
let cwd = "";
const IDENTITY_KEYS = [
	"HERDR_WORKFLOW_ID",
	"HERDR_CHANGE_ID",
	"HERDR_ROLE",
	"HERDR_RUN_TOKEN",
	"HERDR_STEP_ID",
] as const;
let savedIdentity: Record<string, string | undefined> = {};
beforeEach(() => {
	cwd = process.cwd();
	root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-wiki-"));
	savedIdentity = {};
	for (const key of IDENTITY_KEYS) {
		savedIdentity[key] = process.env[key];
		delete process.env[key];
	}
	process.env.HERDR_WIKI_DIR = root;
	process.chdir(root);
});
afterEach(() => {
	process.chdir(cwd);
	delete process.env.HERDR_WIKI_DIR;
	for (const key of IDENTITY_KEYS) {
		if (savedIdentity[key] === undefined) delete process.env[key];
		else process.env[key] = savedIdentity[key];
	}
});

describe("OKF wiki bundle", () => {
	test("creates only an idempotent OKF root index", () => {
		ensureBundle();
		const first = fs.readFileSync(path.join(root, "index.md"), "utf8");
		ensureBundle();
		expect(fs.readFileSync(path.join(root, "index.md"), "utf8")).toBe(first);
		expect(first).toContain('okf_version: "0.2"');
		expect(fs.existsSync(path.join(root, "okf.json"))).toBe(false);
	});
	test("parses and renders nested OKF frontmatter in block style", () => {
		const doc = parseDocument(
			`---\ntype: concept\ngenerated: { by: herdr/p, at: 2025-01-01T00:00:00Z }\nverified:\n  - by: process:archive\n    at: 2025-01-01T00:00:00Z\nsources:\n  - id: docs\n    resource: https://example.test\n    credibility: high\n---\n# Body\n`,
		);
		expect(doc.frontmatter.generated).toBeTruthy();
		expect(trustTier(doc)).toBe("machine-confirmed");
		const rendered = renderDocument(doc.frontmatter, doc.body);
		expect(rendered).toContain("generated: {");
		expect(rendered).toContain("sources:\n");
		expect(
			rendered.split("\n").filter((line) => line.startsWith("type:")).length,
		).toBe(1);
	});
	test("keeps consumer validation permissive", () => {
		expect(
			checkConformance(
				parseDocument("---\ntype: future\nextra: yes\n---\n"),
			).toString(),
		).toBe("true");
		expect(checkConformance(parseDocument("---\nextra: yes\n---\n"))).toBe(
			false,
		);
		expect(() => parseDocument("not markdown frontmatter")).toThrow();
	});
	test("protects paths, tracks lifecycle, and searches ranked concepts", () => {
		expect(() => conceptPath("../escape")).toThrow();
		expect(() => conceptPath("index.md")).toThrow();
		expect(() => conceptPath("log.md")).toThrow();
		writeConcept("title", {
			type: "concept",
			title: "Important title",
			description: "desc",
			tags: ["one"],
			status: "draft",
			generatedBy: "herdr-planner/p",
			changeId: "change",
			body: "Important title claim.[^change]",
		});
		writeConcept("body", {
			type: "concept",
			title: "Other",
			description: "desc",
			sources: [{ id: "code", resource: "src/example.ts" }],
			body: "Important body claim.[^code]",
		});
		expect(listConcepts({ tag: "one" }).map((item) => item.id)).toEqual([
			"title",
		]);
		expect(searchConcepts(["important"], 1)[0]?.id).toBe("title");
		expect(effectiveStatus(readConceptForTest("title"))).toBe("draft");
		expect(
			isStale({
				frontmatter: { stale_after: "2000-01-01T00:00:00Z" },
				body: "",
			}),
		).toBe(true);
	});
	test("snapshots first touch and verifies idempotently", () => {
		writeConcept("existing", {
			type: "concept",
			title: "Old",
			description: "d",
			sources: [{ id: "code", resource: "src/example.ts" }],
			body: "Old fact.[^code]",
		});
		snapshotOnFirstTouch("change", "existing");
		writeConcept("existing", {
			type: "concept",
			title: "New",
			description: "d",
			changeId: "change",
			body: "New fact.[^code]",
		});
		expect(snapshotList("change")).toEqual(["existing"]);
		expect(snapshotRead("change", "existing")).toContain("Old");
		snapshotOnFirstTouch("change", "new");
		expect(snapshotRead("change", "new")).toContain("tombstone");
		verifyConcept("existing", "process:archive");
		verifyConcept("existing", "process:archive");
		expect(readConceptForTest("existing").frontmatter.verified).toHaveLength(1);
	});
	test("managed wiki writes are isolated to the wiki role", async () => {
		const args = [
			"wiki",
			"write",
			"--path",
			"projects/demo/architecture",
			"--type",
			"concept",
			"--title",
			"Architecture",
			"--description",
			"Durable architecture facts",
			"--sources",
			'[{"id":"code","resource":"src/workflow/wiki.ts"}]',
		];
		const saved = {
			workflow: process.env.HERDR_WORKFLOW_ID,
			step: process.env.HERDR_STEP_ID,
			role: process.env.HERDR_ROLE,
			token: process.env.HERDR_RUN_TOKEN,
			change: process.env.HERDR_CHANGE_ID,
		};
		try {
			delete process.env.HERDR_WORKFLOW_ID;
			delete process.env.HERDR_STEP_ID;
			delete process.env.HERDR_ROLE;
			delete process.env.HERDR_RUN_TOKEN;
			delete process.env.HERDR_CHANGE_ID;
			await runWorkflow(args);
			const file = path.join(root, "projects", "demo", "architecture.md");
			const before = fs.readFileSync(file, "utf8");
			expect(before).not.toContain("verified");
			for (const role of [
				"planner",
				"consolidator",
				"archive",
				"worker",
				"verifier",
			]) {
				process.env.HERDR_ROLE = role;
				process.env.HERDR_RUN_TOKEN = "managed";
				await expect(runWorkflow(args)).rejects.toThrow(/not permitted/);
				expect(fs.readFileSync(file, "utf8")).toBe(before);
			}
			for (const wikiRole of ["wiki", "research-wiki"]) {
				process.env.HERDR_ROLE = wikiRole;
				process.env.HERDR_RUN_TOKEN = "managed";
				await expect(
					runWorkflow([...args, "--status", "stable"]),
				).rejects.toThrow(/authenticated core\.wiki run/);
			}
			delete process.env.HERDR_WORKFLOW_ID;
			delete process.env.HERDR_STEP_ID;
			delete process.env.HERDR_ROLE;
			delete process.env.HERDR_RUN_TOKEN;
			await runWorkflow([
				"wiki",
				"verify",
				"--path",
				"projects/demo/architecture",
			]);
			expect(
				readConceptForTest("projects/demo/architecture").frontmatter.status,
			).toBe("stable");
			await expect(
				runWorkflow([
					"wiki",
					"verify",
					"--path",
					"projects/demo/architecture",
					"--actor",
					"process:other",
				]),
			).rejects.toThrow(/process:herdr-archive/);
		} finally {
			if (saved.workflow === undefined) delete process.env.HERDR_WORKFLOW_ID;
			else process.env.HERDR_WORKFLOW_ID = saved.workflow;
			if (saved.step === undefined) delete process.env.HERDR_STEP_ID;
			else process.env.HERDR_STEP_ID = saved.step;
			if (saved.role === undefined) delete process.env.HERDR_ROLE;
			else process.env.HERDR_ROLE = saved.role;
			if (saved.token === undefined) delete process.env.HERDR_RUN_TOKEN;
			else process.env.HERDR_RUN_TOKEN = saved.token;
			if (saved.change === undefined) delete process.env.HERDR_CHANGE_ID;
			else process.env.HERDR_CHANGE_ID = saved.change;
		}
	});
	test("groups log entries by newest ISO date heading", () => {
		appendLog(root, "first");
		appendLog(root, "second");
		const log = fs.readFileSync(path.join(root, "log.md"), "utf8");
		expect(log.match(/^## \d{4}-\d{2}-\d{2}$/gm)).toHaveLength(1);
		expect(log).toContain("- second");
	});
	test("write requires a source and a citation on every prose line", () => {
		expect(() =>
			writeConcept("uncited", {
				type: "concept",
				title: "T",
				description: "d",
				body: "claim without source",
			}),
		).toThrow(/at least one source/);

		expect(() =>
			writeConcept("uncited", {
				type: "concept",
				title: "T",
				description: "d",
				sources: [{ id: "code", resource: "src/example.ts" }],
				body: "A claim.[^code]\nAnother claim.",
			}),
		).toThrow(/line 2 requires a source citation/);

		expect(() =>
			writeConcept("uncited", {
				type: "concept",
				title: "T",
				description: "d",
				sources: [{ id: "code", resource: "src/example.ts" }],
				body: "A claim.[^missing]",
			}),
		).toThrow(/no matching source: missing/);

		writeConcept("cited", {
			type: "concept",
			title: "T",
			description: "d",
			sources: [{ id: "code", resource: "src/example.ts" }],
			body: "# Heading\n\nProse line.[^code]\n\n```ts\nconst x = 1;\n```\n\n- bullet one[^code]\n- bullet two[^code]\n",
		});
		expect(readConceptForTest("cited").frontmatter.stale_after).toBeTruthy();
		expect(readConcept("cited").uncitedLines).toEqual([]);
	});
	test("stamps URL access and expires concepts after two weeks", () => {
		const before = Date.now();
		const concept = writeConcept("url", {
			type: "concept",
			title: "URL",
			description: "d",
			sources: [
				{ id: "web", resource: "https://example.test/doc" },
				{ id: "code", resource: "src/example.ts" },
			],
			body: "Web claim.[^web] Code claim.[^code]",
		});
		const sources = concept.frontmatter.sources as Array<
			Record<string, unknown>
		>;
		const web = sources.find((source) => source.id === "web");
		const code = sources.find((source) => source.id === "code");
		expect(typeof web?.accessed).toBe("string");
		expect(Date.parse(String(web?.accessed))).toBeGreaterThanOrEqual(
			before - 1000,
		);
		expect(code?.accessed).toBeUndefined();
		expect(concept.stale).toBe(false);
		expect(
			Date.parse(String(concept.frontmatter.stale_after)) -
				Date.parse(String(web?.accessed)),
		).toBe(STALE_AFTER_DAYS * 24 * 60 * 60 * 1000);

		const legacy = parseDocument(
			"---\ntype: concept\ntitle: T\ndescription: d\ngenerated: { by: process:herdr, at: 2000-01-01T00:00:00Z }\n---\nA claim.[^code]\n",
		);
		expect(isStale(legacy)).toBe(true);
	});
	test("reading an uncited concept stays permissive and reports coverage", () => {
		fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "legacy", "note.md"),
			"---\ntype: concept\ntitle: Legacy\ndescription: d\n---\nA claim without a citation.\n",
		);
		expect(readConcept("legacy/note").uncitedLines).toEqual([1]);
	});
	test("exempts setext headings, blockquotes, and table separators", () => {
		writeConcept("structural", {
			type: "concept",
			title: "T",
			description: "d",
			sources: [{ id: "code", resource: "src/example.ts" }],
			body: "Setext title\n=====\n\n| a[^code] | b[^code] |\n| --- | --- |\n| one[^code] | two[^code] |\n\n> quoted source text\n\nProse line.[^code]\n",
		});
		expect(readConcept("structural").uncitedLines).toEqual([]);
		expect(readConcept("structural").unknownCitations).toEqual([]);
	});
	test("rejects a source without a stable id", () => {
		expect(() =>
			writeConcept("no-id", {
				type: "concept",
				title: "T",
				description: "d",
				sources: [{ resource: "src/example.ts" }],
				body: "",
			}),
		).toThrow(/sources\[0\] requires an id/);
	});
	test("refuses to promote a concept whose lines are not cited", () => {
		fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "legacy", "stub.md"),
			"---\ntype: concept\ntitle: Stub\ndescription: d\ngenerated: { by: process:herdr, at: 2000-01-01T00:00:00Z }\n---\nUncited fact.\n",
		);
		expect(() => verifyConcept("legacy/stub", "process:herdr-archive")).toThrow(
			/at least one source/,
		);
	});
	test("scans a pathological table-like line in linear time", () => {
		const started = performance.now();
		const report = citationReport(`|${"-".repeat(200_000)}x`);
		expect(report.uncitedLines).toEqual([1]);
		expect(performance.now() - started).toBeLessThan(1000);
	});
	test("CLI rejects the removed --source flag", async () => {
		await expect(
			runWorkflow([
				"wiki",
				"write",
				"--path",
				"projects/demo/x",
				"--type",
				"concept",
				"--title",
				"T",
				"--description",
				"d",
				"--source",
				"src/x.ts",
			]),
		).rejects.toThrow(/--sources/);
	});
});

function readConceptForTest(id: string) {
	return JSON.parse(
		JSON.stringify({
			frontmatter: parseDocument(
				fs.readFileSync(path.join(root, `${id}.md`), "utf8"),
			).frontmatter,
			body: "",
		}),
	) as { frontmatter: Record<string, unknown>; body: string };
}
