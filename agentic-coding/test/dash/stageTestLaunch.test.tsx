/** @jsxImportSource @opentui/solid */
// The Stage test type of the independent-work creation form
// (`add-stage-test-launch`, tasks 1.1 and 3.1).
//
// A stage test runs on exactly one allow-listed hosted stage, so the form reads
// the server's stage catalog and offers only what the server would accept: an
// allow-listed stage shows its environment and access marker, a refused file
// stays visible with its first diagnostic and cannot be selected, and an empty
// catalog explains itself instead of letting a start the server would refuse
// through. The submitted payload carries the stage, the ticket text as the task
// and the optional ticket reference.
import { afterEach, expect, test } from "bun:test";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/solid";
import {
	backendClient,
	clearBackendClient,
	configureBackendClient,
} from "../../src/server/client.ts";
import { stagePaths } from "../../src/server/stages/catalog.ts";
import { stagesStatus } from "../../src/server/stages/operations.ts";
import { launchWorkflow } from "../../src/tui/dash/launch.ts";
import {
	clearStageCatalogSnapshot,
	lastStageCatalogError,
	refreshStageCatalog,
	stageCatalogSnapshot,
} from "../../src/tui/dash/stage-catalog.ts";
import {
	type NewWorkflowInput,
	NewWorkflowModal,
} from "../../src/tui/dash/ui/NewWorkflowModal.tsx";
import { clearGateway, configureGateway } from "../../src/tui/data/index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearGateway();
	clearBackendClient();
	clearStageCatalogSnapshot();
});

function key(
	name: string,
	extra: { meta?: boolean; sequence?: string } = {},
): KeyEvent {
	return new KeyEvent({
		name,
		ctrl: false,
		meta: extra.meta ?? false,
		shift: false,
		option: false,
		sequence: extra.sequence ?? name,
		number: false,
		raw: extra.sequence ?? name,
		eventType: "press",
		source: "raw",
	});
}

const INDEPENDENT = { kind: "independent" } as const;

const VALID_STAGE = {
	ident: "grid-int",
	displayName: "Grid integration",
	environment: "integration",
	system: "grid",
	access: "writable",
	planApproval: "when-writing",
	apps: {
		web: {
			label: "Grid web",
			url: "https://grid-int.example.test/",
			kind: "ui",
		},
	},
};

/** A file the catalog refuses: a credential inlined instead of referenced. */
const REFUSED_STAGE = {
	ident: "grid-legacy",
	displayName: "Grid legacy",
	environment: "integration",
	system: "grid",
	access: "read-only",
	apps: {
		web: {
			label: "Grid web",
			url: "https://grid.example.test/",
			kind: "ui",
			roles: { clerk: { username: "clerk", password: "hunter2hunter2" } },
		},
	},
};

/**
 * A private configuration root the form's catalog read uses. The root is set on
 * the environment for the duration of one test, so no test reads the real
 * configuration and the refusal is a real catalog refusal, not a stubbed list.
 */
async function withStageRoot<T>(
	stages: readonly unknown[],
	run: () => Promise<T>,
): Promise<T> {
	const configDir = mkdtempSync(join(tmpdir(), "stage-launch-"));
	const defsDir = stagePaths(configDir).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	stages.forEach((stage, index) => {
		fs.writeFileSync(
			join(
				defsDir,
				`${String((stage as { ident?: string }).ident ?? index)}.json`,
			),
			`${JSON.stringify(stage, null, 2)}\n`,
		);
	});
	const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
	const previousConfig = process.env.HERDR_WORKFLOW_CONFIG;
	process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
	delete process.env.HERDR_WORKFLOW_CONFIG;
	clearStageCatalogSnapshot();
	try {
		return await run();
	} finally {
		clearStageCatalogSnapshot();
		if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
		else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
		if (previousConfig === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previousConfig;
		rmSync(configDir, { recursive: true, force: true });
	}
}

/** The modal's content column with its wrapped rows joined into one line, so a
 * notice can be asserted whatever width it wrapped at. */
function contentText(frame: string): string {
	return frame
		.split("\n")
		.map((line) => line.trim().split(/\s{2,}/)[0] ?? "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/** The catalog read resolves after the step is entered, so wait for it. */
async function frameContaining(
	t: Awaited<ReturnType<typeof testRender>>,
	needle: string,
): Promise<string> {
	let frame = t.captureCharFrame();
	for (let attempt = 0; attempt < 60 && !frame.includes(needle); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		frame = t.captureCharFrame();
	}
	return frame;
}

/** Render the form for an independent (Wiki) launch and hand back its key
 * handler: the Stage test type is offered there. */
async function renderForm(
	onComplete: (input: NewWorkflowInput) => Promise<void>,
): Promise<{
	t: Awaited<ReturnType<typeof testRender>>;
	press: (event: KeyEvent) => void;
}> {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={INDEPENDENT}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={onComplete}
			/>
		),
		{ width: 140, height: 40 },
	);
	await t.flush();
	return { t, press: (event) => handler?.(event) };
}

/** Walk the type list from `research` to `stage-test` and select it, then step
 * through the preset picker to the stage step. */
async function toStageStep(
	t: Awaited<ReturnType<typeof testRender>>,
	press: (event: KeyEvent) => void,
): Promise<void> {
	// The independent context offers the repository-independent types only, in
	// catalog order: research, then stage-test.
	press(key("j"));
	press(key("enter"));
	await t.flush();
	press(key("enter")); // preset: (config defaults)
	await t.flush();
}

test("the independent form offers Stage test and submits the picked stage", async () => {
	await withStageRoot([VALID_STAGE, REFUSED_STAGE], async () => {
		const completed: NewWorkflowInput[] = [];
		const { t, press } = await renderForm(async (input) => {
			completed.push(input);
		});
		// The type step lists both repository-independent types.
		const types = contentText(t.captureCharFrame());
		expect(types).toContain("Research");
		expect(types).toContain("Stage test");
		await toStageStep(t, press);
		// The picker reads the catalog: the allow-listed stage carries its
		// environment and access marker, and the refused file stays visible with
		// the diagnostic that keeps it out.
		const frame = contentText(await frameContaining(t, "Grid integration"));
		expect(frame).toContain("Stage to test");
		expect(frame).toContain("integration · writable");
		// The refused file stays visible with the diagnostic that keeps it out
		// (its one detail row clips a long diagnostic, as every list row does).
		expect(frame).toContain("grid-legacy");
		expect(frame).toContain("must be exactly one");
		press(key("enter")); // grid-int is the first entry
		await t.flush();
		t.mockInput.pressEnter(); // ticket: optional
		for (const character of "wf-stage-launch") t.mockInput.pressKey(character);
		t.mockInput.pressEnter(); // workflow id
		await t.flush();
		for (const character of "Checkout rejects an expired card")
			t.mockInput.pressKey(character);
		t.mockInput.pressEnter(); // the task text keeps its newline
		for (const character of "and reports a readable error")
			t.mockInput.pressKey(character);
		await t.flush();
		t.mockInput.pressEnter({ meta: true }); // task: Alt+Enter advances
		await t.flush();
		expect(t.captureCharFrame()).toContain("Confirm workflow");
		press(key("return"));
		await t.flush();
		expect(completed).toHaveLength(1);
		expect(completed[0]?.workflowType).toBe("stage-test");
		expect(completed[0]?.stage).toBe("grid-int");
		expect(completed[0]?.ticket).toBe("");
		expect(completed[0]?.task).toBe(
			"Checkout rejects an expired card\nand reports a readable error",
		);
		t.renderer.destroy();
	});
});

test("a refused stage file is shown but cannot be selected", async () => {
	await withStageRoot([VALID_STAGE, REFUSED_STAGE], async () => {
		const completed: NewWorkflowInput[] = [];
		const { t, press } = await renderForm(async (input) => {
			completed.push(input);
		});
		await toStageStep(t, press);
		await frameContaining(t, "grid-legacy");
		press(key("j")); // grid-int -> grid legacy
		press(key("enter"));
		await t.flush();
		const frame = contentText(t.captureCharFrame());
		// The step stays put and says why the entry is not usable.
		expect(frame).toContain("Stage to test");
		expect(frame).toContain("grid-legacy is not in the allow-list");
		expect(frame).toContain("must be exactly one");
		expect(completed).toHaveLength(0);
		t.renderer.destroy();
	});
});

test("an empty stage catalog explains itself and starts nothing", async () => {
	await withStageRoot([], async () => {
		const completed: NewWorkflowInput[] = [];
		const { t, press } = await renderForm(async (input) => {
			completed.push(input);
		});
		await toStageStep(t, press);
		const frame = contentText(
			await frameContaining(t, "No stage is configured"),
		);
		expect(frame).toContain("Stage to test");
		// Nothing to select: Enter cannot advance the form to the ticket step.
		press(key("enter"));
		await t.flush();
		expect(contentText(t.captureCharFrame())).toContain("Stage to test");
		expect(completed).toHaveLength(0);
		t.renderer.destroy();
	});
});

test("a stage-test start submits the stage and the ticket reference", async () => {
	// The form's payload reaches the start boundary as `stage` and `ticket`: a
	// stage the developer picked and a reference the workflow shows in its report
	// travel on the existing start request, and nothing here contacts a ticket
	// system.
	let body: Record<string, unknown> | undefined;
	configureGateway(
		configureBackendClient({
			baseUrl: "http://127.0.0.1:1",
			token: "t",
			ownerId: "test",
		}),
	);
	globalThis.fetch = (async (
		_url: string,
		init?: { body?: string },
	): Promise<Response> => {
		body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
		return Response.json({ ok: true, value: "Workflow started: wf-stage" });
	}) as unknown as typeof fetch;
	expect(backendClient()).toBeDefined();
	const outcome = await launchWorkflow({
		repo: "",
		ticket: "GRID-1234",
		workflowId: "wf-stage",
		mode: "",
		workflowType: "stage-test",
		preset: "Config defaults",
		stage: "grid-int",
		task: "Checkout rejects an expired card",
	});
	expect(outcome.kind).toBe("accepted");
	expect(body).toMatchObject({
		workflowType: "stage-test",
		stage: "grid-int",
		ticket: "GRID-1234",
		task: "Checkout rejects an expired card",
	});
});

test("the stage step reads the catalog over the dashboard transport", async () => {
	await withStageRoot([VALID_STAGE], async () => {
		// The in-process read is the value the transport answers with, so what this
		// asserts is the round trip and the entry the form renders from it.
		const value = stagesStatus();
		configureGateway(
			configureBackendClient({
				baseUrl: "http://127.0.0.1:1",
				token: "t",
				ownerId: "test",
			}),
		);
		const urls: string[] = [];
		globalThis.fetch = (async (url: string): Promise<Response> => {
			urls.push(String(url));
			return Response.json({ ok: true, value });
		}) as unknown as typeof fetch;
		const { t, press } = await renderForm(async () => {});
		await toStageStep(t, press);
		const frame = contentText(await frameContaining(t, "Grid integration"));
		expect(urls).toContain("http://127.0.0.1:1/api/v1/stages");
		expect(frame).toContain("Stage to test");
		expect(frame).toContain("integration · writable");
		expect(stageCatalogSnapshot()?.stages[0]?.ident).toBe("grid-int");
		t.renderer.destroy();
	});
});

test("a failed catalog read is reported instead of an empty picker", async () => {
	await withStageRoot([VALID_STAGE], async () => {
		configureBackendClient({
			baseUrl: "http://127.0.0.1:1",
			token: "t",
			ownerId: "test",
		});
		globalThis.fetch = (async (): Promise<Response> =>
			Response.json(
				{ ok: false, error: { message: "catalog exploded" } },
				{ status: 500 },
			)) as unknown as typeof fetch;
		const completed: NewWorkflowInput[] = [];
		const { t, press } = await renderForm(async (input) => {
			completed.push(input);
		});
		await toStageStep(t, press);
		const frame = contentText(
			await frameContaining(t, "Stages could not be read"),
		);
		expect(frame).toContain("catalog exploded");
		// One owner for the empty list: the header reports the failed read, and the
		// list says neither that nothing is configured nor that the query matched
		// nothing.
		expect(frame).not.toContain("No stage is configured");
		expect(frame).not.toContain("No stage matches");
		press(key("enter"));
		await t.flush();
		expect(completed).toHaveLength(0);
		t.renderer.destroy();
	});
});

test("re-entering the stage step after a failed read retries it", async () => {
	await withStageRoot([VALID_STAGE], async () => {
		// The notice promises a retry on re-entry, so the second read has to be a
		// real read that replaces the failure with the catalog.
		const value = stagesStatus();
		configureGateway(
			configureBackendClient({
				baseUrl: "http://127.0.0.1:1",
				token: "t",
				ownerId: "test",
			}),
		);
		let failReads = true;
		globalThis.fetch = (async (): Promise<Response> =>
			failReads
				? Response.json(
						{ ok: false, error: { message: "catalog exploded" } },
						{ status: 500 },
					)
				: Response.json({ ok: true, value })) as unknown as typeof fetch;
		const { t, press } = await renderForm(async () => {});
		await toStageStep(t, press);
		expect(
			contentText(await frameContaining(t, "Stages could not be read")),
		).toContain("catalog exploded");
		failReads = false;
		press(key("escape")); // back to the preset step
		await t.flush();
		press(key("enter")); // and into the stage step again
		const frame = contentText(await frameContaining(t, "Grid integration"));
		expect(frame).not.toContain("Stages could not be read");
		expect(frame).not.toContain("catalog exploded");
		expect(stageCatalogSnapshot()?.stages[0]?.ident).toBe("grid-int");
		t.renderer.destroy();
	});
});

test("confirming without the ticket text sends the form back to that step", async () => {
	await withStageRoot([VALID_STAGE], async () => {
		const completed: NewWorkflowInput[] = [];
		const { t, press } = await renderForm(async (input) => {
			completed.push(input);
		});
		await toStageStep(t, press);
		await frameContaining(t, "Grid integration");
		press(key("enter")); // stage: grid-int
		await t.flush();
		t.mockInput.pressEnter(); // ticket: optional
		for (const character of "wf-stage-bounce") t.mockInput.pressKey(character);
		t.mockInput.pressEnter(); // workflow id
		await t.flush();
		// The task carries the ticket text, so its label says so.
		expect(contentText(t.captureCharFrame())).toContain(
			"Ticket text (the task)",
		);
		t.mockInput.pressEnter({ meta: true }); // task: Alt+Enter advances empty
		await t.flush();
		const confirmFrame = contentText(t.captureCharFrame());
		expect(confirmFrame).toContain("Confirm workflow");
		// The confirmation names what is still missing instead of letting Enter look
		// like it did nothing.
		expect(confirmFrame).toContain("Still required");
		press(key("return"));
		await t.flush();
		const frame = contentText(t.captureCharFrame());
		// The form is back on the step that owns the missing value, it says so above
		// the editor, and nothing started.
		expect(frame).toContain("Ticket text (the task)");
		expect(frame).toContain(
			"The ticket text is required before the workflow can start.",
		);
		expect(frame).not.toContain("Confirm workflow");
		expect(completed).toHaveLength(0);
		t.renderer.destroy();
	});
});

test("the stage step filters its entries and says when nothing matches", async () => {
	await withStageRoot([VALID_STAGE, REFUSED_STAGE], async () => {
		const { t, press } = await renderForm(async () => {});
		await toStageStep(t, press);
		await frameContaining(t, "Grid integration");
		press(key("/"));
		for (const character of "legacy") press(key(character));
		await t.flush();
		const narrowed = contentText(t.captureCharFrame());
		expect(narrowed).toContain("grid-legacy");
		expect(narrowed).not.toContain("Grid integration");
		for (const character of "zzz") press(key(character));
		await t.flush();
		const unmatched = contentText(
			await frameContaining(t, 'No stage matches "legacyzzz"'),
		);
		// The catalog is not empty, so the step must not say it is.
		expect(unmatched).toContain("Stage to test");
		expect(unmatched).not.toContain("No stage is configured");
		t.renderer.destroy();
	});
});

test("the confirmation names the picked stage with its access marker", async () => {
	await withStageRoot([VALID_STAGE], async () => {
		const { t, press } = await renderForm(async () => {});
		await toStageStep(t, press);
		await frameContaining(t, "Grid integration");
		press(key("enter")); // stage: grid-int
		await t.flush();
		t.mockInput.pressEnter(); // ticket: optional
		for (const character of "wf-stage-summary") t.mockInput.pressKey(character);
		t.mockInput.pressEnter(); // workflow id
		await t.flush();
		for (const character of "Check the request")
			t.mockInput.pressKey(character);
		await t.flush();
		t.mockInput.pressEnter({ meta: true });
		await t.flush();
		// The row carries what the decision rested on: the stage's display name and
		// whether the run may write to it.
		const frame = t.captureCharFrame();
		expect(frame).toContain("Grid integration");
		expect(frame).toContain("integration · writable");
		t.renderer.destroy();
	});
});

test("an abandoned catalog read cannot overwrite the newer snapshot", async () => {
	configureBackendClient({
		baseUrl: "http://127.0.0.1:1",
		token: "t",
		ownerId: "test",
	});
	// Each read answers when the test says so, so two reads overlap exactly as
	// the form's re-entered stage step makes them.
	const answers: Array<(value: Response) => void> = [];
	globalThis.fetch = (() =>
		new Promise<Response>((resolve) => {
			answers.push(resolve);
		})) as unknown as typeof fetch;
	const catalog = (configDir: string) => ({
		configDir,
		stages: [],
		excluded: [],
	});
	const failing = (message: string) =>
		Response.json({ ok: false, error: { message } }, { status: 500 });
	const older = refreshStageCatalog();
	const newer = refreshStageCatalog();
	answers[1]?.(Response.json({ ok: true, value: catalog("/newer") }));
	expect((await newer).snapshot?.configDir).toBe("/newer");
	answers[0]?.(failing("old read failed"));
	// The abandoned read answers its own caller with its own failure, while the
	// snapshot and the committed error stay those of the newest read.
	const olderRead = await older;
	expect(olderRead.snapshot).toBeUndefined();
	expect(olderRead.error).toBe("old read failed");
	expect(stageCatalogSnapshot()?.configDir).toBe("/newer");
	expect(lastStageCatalogError()).toBeUndefined();
	// A clear retires the reads in flight too: nothing resurrects a snapshot the
	// form has already dropped.
	const cleared = refreshStageCatalog();
	clearStageCatalogSnapshot();
	answers[2]?.(Response.json({ ok: true, value: catalog("/cleared") }));
	expect((await cleared).snapshot?.configDir).toBe("/cleared");
	expect(stageCatalogSnapshot()).toBeUndefined();
	expect(lastStageCatalogError()).toBeUndefined();
});

test("each overlapping catalog read reports its own failure", async () => {
	configureBackendClient({
		baseUrl: "http://127.0.0.1:1",
		token: "t",
		ownerId: "test",
	});
	const answers: Array<(value: Response) => void> = [];
	globalThis.fetch = (() =>
		new Promise<Response>((resolve) => {
			answers.push(resolve);
		})) as unknown as typeof fetch;
	const failing = (message: string) =>
		Response.json({ ok: false, error: { message } }, { status: 500 });
	const abandoned = refreshStageCatalog();
	const newest = refreshStageCatalog();
	answers[1]?.(failing("newest read failed"));
	answers[0]?.(failing("abandoned read failed"));
	// Each caller carries its own answer: a read must never report the message of
	// a read it did not make, and a failed newest read must not leave an older
	// caller with no message at all.
	expect((await newest).error).toBe("newest read failed");
	expect((await abandoned).error).toBe("abandoned read failed");
	expect(stageCatalogSnapshot()).toBeUndefined();
	expect(lastStageCatalogError()).toBe("newest read failed");
});
