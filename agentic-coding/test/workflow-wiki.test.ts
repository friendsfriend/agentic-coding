import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { AgentHandle } from "../src/contracts/workflow.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import type { AgentAdapter, LaunchContext } from "../src/workflow/adapters.ts";
import { run as runWorkflow } from "../src/workflow/cli.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import { stageTestWorkflowTarget } from "../src/workflow/runtime/targets.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";
import { prepareWorkflowStart } from "../src/workflow/startup.ts";
import { CLASSIFIABLE_STEPS } from "../src/workflow/steps/index.ts";
import {
	appendLog,
	checkConformance,
	citationReport,
	conceptPath,
	containsConfiguredSecret,
	effectiveStatus,
	ensureBundle,
	isStale,
	listConcepts,
	parseDocument,
	readConcept,
	readConceptWithDigest,
	renderDocument,
	STALE_AFTER_DAYS,
	searchConcepts,
	snapshotList,
	snapshotOnFirstTouch,
	snapshotRead,
	trustTier,
	verifyConcept,
	wikiContentDigest,
	writeConcept,
} from "../src/workflow/wiki.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	removeRepoFixture,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

class StageWikiStubAdapter implements AgentAdapter {
	readonly id = "pi-durable" as const;
	launch(ctx: LaunchContext) {
		return Effect.succeed({
			runtime: "pi-durable" as const,
			name: ctx.name,
			hostSocket: "/tmp/host.sock",
			sessionId: ctx.assignment.runId,
		});
	}
	preflight() {}
	prompt() {
		return Effect.void;
	}
	observe(_handle: AgentHandle) {
		return Effect.succeed({ status: "working" as const });
	}
	stop() {
		return Effect.void;
	}
}

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
	// The bundle this case built is a real directory tree, and it is this file's
	// to remove: without the sweep it left one `agentic-wiki-*` tree per case in
	// the temp directory.
	fs.rmSync(root, { recursive: true, force: true });
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
	test("scoped searches rank only concepts inside the requested system namespace", () => {
		for (const [id, title] of [
			["projects/grid-allocation/processes/request", "Request process"],
			["projects/other/processes/request", "Request process"],
		] as const) {
			writeConcept(id, {
				type: "process",
				title,
				description: "Process notes",
				sources: [{ id: "ticket", resource: "ticket://request" }],
				body: "The request enters review.[^ticket]",
			});
		}
		expect(
			searchConcepts(["request"], 20, "projects/grid-allocation/").map(
				({ id }) => id,
			),
		).toEqual(["projects/grid-allocation/processes/request"]);
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
	test("a stage draft containing a configured secret is refused without naming it", () => {
		const values = ["", "declared-value"];
		expect(
			containsConfiguredSecret(
				JSON.stringify({ body: "use declared-value here" }),
				values,
			),
		).toBe(true);
		expect(containsConfiguredSecret("a clean draft", values)).toBe(false);
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
			for (const wikiRole of ["wiki", "research-wiki", "stage-wiki"]) {
				process.env.HERDR_ROLE = wikiRole;
				process.env.HERDR_RUN_TOKEN = "managed";
				const authorization = runWorkflow([...args, "--status", "stable"]);
				// A stage-wiki write needs the authenticated stage-test boundary;
				// the write it guards is covered below by the real stage-wiki run.
				if (wikiRole === "stage-wiki") {
					await expect(authorization).rejects.toThrow(
						/authenticated stage-test step/,
					);
				} else {
					await expect(authorization).rejects.toThrow(
						/authenticated core\.wiki run/,
					);
				}
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
	test("an authenticated stage-wiki run writes only inside the pinned stage scope", async () => {
		const configDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "agentic-stage-wiki-"),
		);
		const repo = createTempRepoFixture("agentic-stage-wiki-repo-", {
			files: { "README.md": "stage wiki\n" },
		});
		const saved = {
			configDir: process.env.AGENTIC_CODING_CONFIG_DIR,
			workflowConfig: process.env.HERDR_WORKFLOW_CONFIG,
			wikiDir: process.env.HERDR_WIKI_DIR,
			target: process.env.HERDR_WORKFLOW_TARGET,
		};
		const previousCwd = process.cwd();
		try {
			process.chdir(repo);
			process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
			delete process.env.HERDR_WORKFLOW_CONFIG;
			// The pinned root is the configured one: the write guard compares the
			// resolved destination with the snapshot's `wikiRoot`, which the start
			// pinned from the configuration and not from the process environment.
			delete process.env.HERDR_WIKI_DIR;
			process.env.HERDR_WORKFLOW_TARGET = stageTestWorkflowTarget();
			const pools = Object.fromEntries(
				Object.entries(CLASSIFIABLE_STEPS).map(([stepId, mode]) => [
					stepId,
					Array.from({ length: mode === "roster" ? 2 : 1 }, (_, index) => ({
						label: `p${index + 1}`,
						profile: `p${index + 1}`,
						default: true,
					})),
				]),
			);
			fs.writeFileSync(
				path.join(configDir, "config.json"),
				JSON.stringify({
					wiki: { root },
					agents: {
						default_profile: "p1",
						profiles: Object.fromEntries(
							["p1", "p2"].map((name) => [
								name,
								{
									runtime: "pi-durable",
									executable: "/bin/true",
									capabilities: [
										"prompt",
										"run-environment",
										"observe",
										"vision",
										"shell",
										"edit",
									],
								},
							]),
						),
						presets: {
							fixed: { default_profile: "p1", pools },
						},
					},
				}),
			);
			fs.mkdirSync(stagePaths(configDir).defsDir, { recursive: true });
			fs.writeFileSync(
				path.join(stagePaths(configDir).defsDir, "grid-int.json"),
				JSON.stringify({
					ident: "grid-int",
					displayName: "Grid integration",
					environment: "integration",
					system: "grid-allocation",
					access: "read-only",
					apps: {
						web: {
							label: "Grid web",
							url: "https://grid.example.test/",
							kind: "ui",
						},
					},
					wiki: { processes: ["grid-connection-request"] },
				}),
			);
			const workflowId = "stage-wiki-write";
			const registry = registerBuiltins();
			const engine = new WorkflowEngine(registry);
			const prepared = prepareWorkflowStart({
				repo,
				workflowId,
				definitionId: "stage-test",
				task: "check the grid connection request status",
				stage: "grid-int",
				preset: "fixed",
			});
			engine.start(prepared.input);
			engine.dispatch(prepared.target, {
				type: "operator.repair",
				workflowId,
				revision: engine.getSnapshot(prepared.target, workflowId).revision,
				targetStep: "core.wiki",
				reason: "stage wiki write fixture",
			});
			await new EffectRunner(
				prepared.target,
				engine,
				agentEffectHandlers(prepared.target, engine, {
					registry,
					adapters: new Map([["pi-durable", new StageWikiStubAdapter()]]),
				}),
			).drain(5);
			const run = engine
				.status(prepared.target, workflowId)
				.runs.find(({ stepId }) => stepId === "core.wiki");
			if (!run) throw new Error("missing core.wiki run");
			process.env.HERDR_WORKFLOW_ID = workflowId;
			process.env.HERDR_STEP_ID = "core.wiki";
			process.env.HERDR_ROLE = "stage-wiki";
			process.env.HERDR_RUN_ID = run.id;
			process.env.HERDR_RUN_TOKEN = engine.issueRunCapability(
				prepared.target,
				run.id,
			);
			const body = [
				"## Purpose",
				"## Actors",
				"## Steps",
				"## Decisions & rules",
				"## Inputs",
				"## Outputs",
				"## Open questions",
			]
				.map((heading) => `${heading}\n\nObserved.[^stage]`)
				.join("\n\n");
			const runOutputPath = engine.getRun(prepared.target, run.id).outputPath;
			if (!runOutputPath) throw new Error("missing wiki run output path");
			const bodyFile = path.join(path.dirname(runOutputPath), "process.md");
			fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
			fs.writeFileSync(bodyFile, body);
			const citation = `stage://grid-int/${workflowId}`;
			const argsFor = (
				path: string,
				sources: string,
				expectedDigest = "absent",
			) => [
				"wiki",
				"write",
				"--path",
				path,
				"--type",
				"process",
				"--title",
				"Grid connection request",
				"--description",
				"Observed process",
				"--sources",
				sources,
				"--expected-digest",
				expectedDigest,
				"--body-file",
				bodyFile,
			];
			const conceptId =
				"projects/grid-allocation/processes/grid-connection-request";
			const args = argsFor(
				conceptId,
				JSON.stringify([{ id: "stage", resource: citation }]),
			);
			const withoutExpectedDigest = args.filter(
				(value, index) =>
					value !== "--expected-digest" &&
					args[index - 1] !== "--expected-digest",
			);
			await expect(runWorkflow(withoutExpectedDigest)).rejects.toThrow(
				/stage wiki writes require --expected-digest/,
			);
			await runWorkflow(args);
			const concept = readConceptForTest(conceptId);
			const showOutput = spyOn(console, "log").mockImplementation(() => {});
			const showValue = await runWorkflow(["wiki", "show", conceptId])
				.then(() => showOutput.mock.calls.at(-1)?.[0])
				.finally(() => showOutput.mockRestore());
			const shown = JSON.parse(String(showValue)) as {
				contentDigest?: unknown;
			};
			expect(shown.contentDigest).toBe(wikiContentDigest(conceptId));
			expect(concept.frontmatter.status).toBe("draft");
			expect(JSON.stringify(concept.frontmatter.sources)).toContain(citation);

			// The sibling wiki roles are not admitted to a stage-test run.
			for (const role of ["wiki", "research-wiki"]) {
				process.env.HERDR_ROLE = role;
				await expect(runWorkflow(args)).rejects.toThrow();
			}
			process.env.HERDR_ROLE = "stage-wiki";

			// The pinned system's namespace is the only writable one.
			await expect(
				runWorkflow(
					argsFor(
						"projects/other/processes/grid-connection-request",
						JSON.stringify([{ id: "stage", resource: citation }]),
					),
				),
			).rejects.toThrow(/outside the pinned system/);
			// The stage citation is mandatory.
			await expect(
				runWorkflow(
					argsFor(
						"projects/grid-allocation/processes/grid-connection-request",
						JSON.stringify([{ id: "ticket", resource: "ticket://x" }]),
					),
				),
			).rejects.toThrow(/must cite stage:\/\/grid-int/);

			// A declared configuration secret is refused by the write command and
			// the message never repeats the value.
			fs.writeFileSync(
				path.join(configDir, ".env"),
				"STAGE_SECRET=declared-secret-value\n",
			);
			fs.writeFileSync(
				bodyFile,
				body.replace("Observed.", "Observed with declared-secret-value."),
			);
			const refusal = runWorkflow(args).catch((error: unknown) => error);
			const error = await refusal;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/configured secret/);
			expect((error as Error).message).not.toContain("declared-secret-value");
		} finally {
			process.chdir(previousCwd);
			removeRepoFixture(repo);
			fs.rmSync(configDir, { recursive: true, force: true });
			for (const [key, value] of [
				["AGENTIC_CODING_CONFIG_DIR", saved.configDir],
				["HERDR_WORKFLOW_CONFIG", saved.workflowConfig],
				["HERDR_WIKI_DIR", saved.wikiDir],
				["HERDR_WORKFLOW_TARGET", saved.target],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
	test("groups log entries by newest ISO date heading", () => {
		appendLog(root, "first");
		appendLog(root, "second");
		const log = fs.readFileSync(path.join(root, "log.md"), "utf8");
		expect(log.match(/^## \d{4}-\d{2}-\d{2}$/gm)).toHaveLength(1);
		expect(log).toContain("- second");
	});
	test("wiki show returns content and digest from the same byte snapshot during replacement", async () => {
		const id = "projects/grid/processes/request";
		const input = {
			type: "process",
			title: "Request",
			description: "Business process",
			sources: [{ id: "stage", resource: "stage://grid/run" }],
			body: "Original business knowledge.[^stage]",
		};
		writeConcept(id, input, root);
		const file = conceptPath(id, root);
		const originalBytes = fs.readFileSync(file);
		const document = parseDocument(originalBytes.toString("utf8"));
		const replacement = renderDocument(
			document.frontmatter,
			"Newer business knowledge.[^stage]",
		);
		const originalRead = fs.readFileSync;
		let targetReads = 0;
		const read = spyOn(fs, "readFileSync").mockImplementation(((
			...args: Parameters<typeof fs.readFileSync>
		) => {
			const bytes = originalRead(...args);
			if (String(args[0]) === file) {
				targetReads++;
				if (targetReads === 1) {
					const temporary = `${file}.replacement`;
					fs.writeFileSync(temporary, replacement);
					fs.renameSync(temporary, file);
				}
			}
			return bytes;
		}) as typeof fs.readFileSync);
		const output = spyOn(console, "log").mockImplementation(() => {});
		let shown: ReturnType<typeof readConceptWithDigest>;
		try {
			await runWorkflow(["wiki", "show", id]);
			shown = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
			expect(targetReads).toBe(1);
		} finally {
			read.mockRestore();
			output.mockRestore();
		}
		expect(shown.body).toContain("Original business knowledge");
		expect(shown.contentDigest).toBe(
			createHash("sha256").update(originalBytes).digest("hex"),
		);
		expect(readConceptWithDigest(id, root).body).toContain(
			"Newer business knowledge",
		);
		expect(() =>
			writeConcept(
				id,
				{ ...input, body: "Stale rewrite.[^stage]" },
				root,
				shown.contentDigest,
			),
		).toThrow(/changed since it was read/);
		expect(readConcept(id, root).body).toContain("Newer business knowledge");
	});
	test("abandoned wiki locks fail closed for every waiter without removing a lock generation", () => {
		const id = "projects/grid/processes/request";
		const input = {
			type: "process",
			title: "Request",
			description: "Business process",
			sources: [{ id: "stage", resource: "stage://grid/run" }],
			body: "Original.[^stage]",
		};
		writeConcept(id, input, root);
		const digest = wikiContentDigest(id, root);
		const lock = `${conceptPath(id, root)}.write-lock`;
		fs.mkdirSync(lock);
		fs.writeFileSync(
			path.join(lock, "owner.json"),
			JSON.stringify({ pid: 2147483647 }),
		);
		const old = new Date(Date.now() - 120000);
		fs.utimesSync(lock, old, old);
		const inode = fs.statSync(lock).ino;
		let time = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => {
			time += 60001;
			return time;
		});
		try {
			for (const body of ["First.[^stage]", "Second.[^stage]"])
				expect(() =>
					writeConcept(id, { ...input, body }, root, digest),
				).toThrow(/abandoned locks require operator cleanup/);
			expect(() =>
				verifyConcept(id, "human:reviewer", undefined, true, root, digest),
			).toThrow(/abandoned locks require operator cleanup/);
			expect(fs.statSync(lock).ino).toBe(inode);
			expect(wikiContentDigest(id, root)).toBe(digest);
		} finally {
			clock.mockRestore();
			fs.rmSync(lock, { recursive: true, force: true });
		}
	});
	test("stale wiki writes cannot overwrite a newer process-page revision", () => {
		const concept =
			"projects/grid-allocation/processes/grid-connection-request";
		const input = {
			type: "process",
			title: "Grid connection request",
			description: "Business process",
			sources: [{ id: "stage", resource: "stage://grid-int/run-1" }],
			body: "The request is submitted.[^stage]",
		};
		writeConcept(concept, input, root);
		const readDigest = wikiContentDigest(concept, root);
		writeConcept(
			concept,
			{
				...input,
				body: "The request is submitted and the operator reviews it.[^stage]",
			},
			root,
			readDigest,
		);
		expect(() =>
			writeConcept(
				concept,
				{ ...input, body: "A stale update.[^stage]" },
				root,
				readDigest,
			),
		).toThrow(/changed since it was read/);
		expect(readConcept(concept, root).body).toContain(
			"the operator reviews it.",
		);
		expect(readConcept(concept, root).body).not.toContain("A stale update.");
	});
	test("verification refuses an approved snapshot superseded by a writer", () => {
		const id = "projects/grid/processes/request";
		const input = {
			type: "process",
			title: "Request",
			description: "Business process",
			sources: [{ id: "stage", resource: "stage://grid/run" }],
			body: "Original.[^stage]",
		};
		writeConcept(id, input, root);
		const approved = fs.readFileSync(conceptPath(id, root), "utf8");
		const digest = wikiContentDigest(id, root);
		writeConcept(
			id,
			{ ...input, body: "New business knowledge.[^stage]" },
			root,
			digest,
		);
		expect(() =>
			verifyConcept(id, "human:reviewer", approved, true, root, digest),
		).toThrow(/changed after developer approval/);
		expect(readConcept(id, root).body).toContain("New business knowledge");
		expect(readConcept(id, root).frontmatter.verified).toBeUndefined();
	});
	test("concurrent stale-base writers serialize their digest checks", async () => {
		const id = "projects/grid/processes/request";
		const input = {
			type: "process",
			title: "Request",
			description: "Business process",
			sources: [{ id: "stage", resource: "stage://grid/run" }],
			body: "Original.[^stage]",
		};
		writeConcept(id, input, root);
		const digest = wikiContentDigest(id, root);
		const lock = `${conceptPath(id, root)}.write-lock`;
		fs.mkdirSync(lock);
		fs.writeFileSync(
			path.join(lock, "owner.json"),
			JSON.stringify({ pid: process.pid }),
		);
		const moduleUrl = new URL("../src/workflow/wiki.ts", import.meta.url).href;
		const script = `
			import { writeConcept } from ${JSON.stringify(moduleUrl)};
			console.log("ready");
			await Bun.stdin.text();
			try {
				writeConcept(${JSON.stringify(id)}, {...${JSON.stringify(input)}, body: process.env.RACE_BODY}, ${JSON.stringify(root)}, ${JSON.stringify(digest)});
				console.log("won");
			} catch (error) {
				if (!error.message.includes("changed since it was read")) throw error;
				console.log("stale");
			}
		`;
		const children = ["First", "Second"].map((name) =>
			Bun.spawn([process.execPath, "-e", script], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, RACE_BODY: `${name} knowledge.[^stage]` },
			}),
		);
		try {
			await Promise.all(
				children.map(async (child) => {
					const reader = child.stdout.getReader();
					const ready = await reader.read();
					expect(new TextDecoder().decode(ready.value)).toContain("ready");
					reader.releaseLock();
					child.stdin.end();
				}),
			);
			await Bun.sleep(100);
			expect(wikiContentDigest(id, root)).toBe(digest);
			fs.rmSync(lock, { recursive: true });
			const outcomes = await Promise.all(
				children.map(async (child) => {
					const [stdout, stderr, exit] = await Promise.all([
						(async () => {
							const reader = child.stdout.getReader();
							const decoder = new TextDecoder();
							let text = "";
							while (true) {
								const chunk = await reader.read();
								if (chunk.done) break;
								text += decoder.decode(chunk.value, { stream: true });
							}
							return text + decoder.decode();
						})(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					expect(stderr).toBe("");
					expect(exit).toBe(0);
					return stdout.trim();
				}),
			);
			expect([...outcomes].sort()).toEqual(["stale", "won"]);
			const winner = outcomes.indexOf("won");
			expect(readConcept(id, root).body).toContain(
				`${winner === 0 ? "First" : "Second"} knowledge`,
			);
		} finally {
			fs.rmSync(lock, { recursive: true, force: true });
			for (const child of children) child.kill();
		}
	}, 15000);
	test("scoped process listing never enumerates unrelated project trees", () => {
		const input = {
			type: "process",
			title: "Request",
			description: "Business process",
			sources: [{ id: "stage", resource: "stage://grid/run" }],
			body: "Request.[^stage]",
		};
		writeConcept("projects/grid/processes/request", input, root);
		writeConcept("projects/other/processes/request", input, root);
		const scan = spyOn(fs, "readdirSync");
		try {
			expect(
				listConcepts(
					{ type: "process", idPrefix: "projects/grid/processes" },
					root,
				).map(({ id }) => id),
			).toEqual(["projects/grid/processes/request"]);
			expect(scan.mock.calls.map(([dir]) => String(dir))).toEqual([
				path.join(root, "projects/grid/processes"),
			]);
		} finally {
			scan.mockRestore();
		}
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
