import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run as runWorkflow } from "../src/workflow/cli.ts";
import {
	appendLog,
	checkConformance,
	conceptPath,
	effectiveStatus,
	ensureBundle,
	isStale,
	listConcepts,
	parseDocument,
	renderDocument,
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
beforeEach(() => {
	cwd = process.cwd();
	root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-wiki-"));
	process.env.HERDR_WIKI_DIR = root;
	process.chdir(root);
});
afterEach(() => {
	process.chdir(cwd);
	delete process.env.HERDR_WIKI_DIR;
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
		});
		writeConcept("body", {
			type: "concept",
			title: "Other",
			description: "desc",
			body: "Important body",
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
		});
		snapshotOnFirstTouch("change", "existing");
		writeConcept("existing", {
			type: "concept",
			title: "New",
			description: "d",
			changeId: "change",
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
			process.env.HERDR_ROLE = "wiki";
			process.env.HERDR_RUN_TOKEN = "managed";
			await expect(
				runWorkflow([...args, "--status", "stable"]),
			).rejects.toThrow(/authenticated core\.wiki run/);
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
