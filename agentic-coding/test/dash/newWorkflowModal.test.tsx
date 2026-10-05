/** @jsxImportSource @opentui/solid */
// Contextual creation form (launch-workflows-from-project-and-wiki-pages,
// tasks 1.2/3.1/3.2; environment selection in the repository step): the launch
// context is immutable, so a configured project and Wiki never ask for a
// target. Home's own directory is the one repository step, and its picker
// offers the configured applications/libraries, the directory it was opened
// with and a custom path.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { ObservationRequest } from "../../src/contracts/environment.ts";
import type { DashboardGateway } from "../../src/contracts/gateway.ts";
import {
	type NewWorkflowInput,
	NewWorkflowModal,
} from "../../src/tui/dash/ui/NewWorkflowModal.tsx";
import {
	cache,
	clearGateway,
	configureGateway,
} from "../../src/tui/data/index.ts";
import type { ProjectOption } from "../../src/tui/data/workflow.ts";

afterEach(() => clearGateway());

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

const PROJECT = {
	kind: "project",
	ident: "fixture",
	name: "Fixture",
	repository: "/managed/fixture",
} as const;

const INDEPENDENT = { kind: "independent" } as const;

const PATH = { kind: "path", repository: "/working/dir" } as const;

/** Configured catalog as the environment pages read it: one available
 * application and one library whose checkout is gone. */
const BILLING: ProjectOption = {
	name: "Billing API",
	path: "/managed/billing",
	openspec: true,
	ident: "billing",
	available: true,
	availability: "available",
};

const BUN_LIB: ProjectOption = {
	name: "bun-lib-starter",
	path: "/managed/bun-lib-starter",
	openspec: false,
	ident: "bun-lib",
	available: false,
	availability: "missing",
	detail: "checkout is missing",
};

/** Serve the configured-project catalog through the dashboard port the modal
 * reads its repository entries from. */
function useProjects(projects: ProjectOption[]): void {
	configureGateway({
		observe: async (observation: ObservationRequest) => {
			if (observation.kind === "projects") return projects;
			throw new Error(`unexpected ${observation.kind}`);
		},
	} as unknown as DashboardGateway);
}

/** Serve the catalog through a read the test releases when it chooses: the
 * repository step is usable while the read is still in flight. */
function useDeferredProjects(): (projects: ProjectOption[]) => void {
	let settle: ((projects: ProjectOption[]) => void) | undefined;
	configureGateway({
		observe: (observation: ObservationRequest) => {
			if (observation.kind === "projects")
				return new Promise<unknown>((resolve) => {
					settle = resolve as (projects: ProjectOption[]) => void;
				});
			return Promise.reject(new Error(`unexpected ${observation.kind}`));
		},
	} as unknown as DashboardGateway);
	return (projects) => {
		const resolve = settle;
		settle = undefined;
		resolve?.(projects);
	};
}

/** Serve a catalog read that fails. */
function useFailingProjects(message: string): void {
	configureGateway({
		observe: (observation: ObservationRequest) =>
			observation.kind === "projects"
				? Promise.reject(new Error(message))
				: Promise.reject(new Error(`unexpected ${observation.kind}`)),
	} as unknown as DashboardGateway);
}

/** The line of a captured frame that carries `needle`. */
function frameLine(frame: string, needle: string): string {
	return frame.split("\n").find((line) => line.includes(needle)) ?? "";
}

/** The modal's content column with its wrapped rows joined back into one line
 * (the column is padded to the summary table, so a row ends at the first run of
 * spaces): a notice can be asserted whatever width it wrapped at. */
function contentText(frame: string): string {
	return frame
		.split("\n")
		.map((line) => line.trim().split(/\s{2,}/)[0] ?? "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/** The catalog read resolves after mount, so wait for the entry it adds. */
async function frameContaining(
	t: Awaited<ReturnType<typeof testRender>>,
	needle: string,
): Promise<string> {
	let frame = t.captureCharFrame();
	for (let attempt = 0; attempt < 50 && !frame.includes(needle); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		frame = t.captureCharFrame();
	}
	return frame;
}

test("a path context offers the opened directory and a custom path", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PATH}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		{ width: 110, height: 40 },
	);
	await t.flush();
	const first = t.captureCharFrame();
	// The step is a picker: the directory the form opened with is its default
	// entry, and a custom path stays one entry away.
	expect(first).toContain("Repository");
	expect(first).toContain("/working/dir");
	expect(first).toContain("Repository path");
	expect(first).toContain("Current directory (dir)");
	expect(first).toContain("Custom path…");
	handler?.(key("j")); // current directory -> custom path
	handler?.(key("enter")); // open the free-path editor
	await t.flush();
	// The native editor owns the field: clear the prefill and enter another path.
	for (let index = 0; index < "/working/dir".length; index += 1)
		t.mockInput.pressBackspace();
	for (const character of "/custom/repo") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.flush();
	const next = t.captureCharFrame();
	expect(next).toContain("Repository");
	expect(next).toContain("/custom/repo");
	expect(next).toContain("Workflow type");
	t.renderer.destroy();
});

test("Esc leaves the custom-path editor for the picker before it leaves the step", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	let cancelled = 0;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PATH}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {
					cancelled += 1;
				}}
				onComplete={async () => {}}
			/>
		),
		{ width: 110, height: 40 },
	);
	await t.flush();
	handler?.(key("j")); // current directory -> custom path
	handler?.(key("enter")); // open the free-path editor
	await t.flush();
	expect(t.captureCharFrame()).not.toContain("Custom path…");
	handler?.(key("escape")); // back to the picker, not out of the form
	await t.flush();
	expect(t.captureCharFrame()).toContain("Custom path…");
	expect(cancelled).toBe(0);
	handler?.(key("escape")); // the picker's own Esc leaves the step
	expect(cancelled).toBe(1);
	t.renderer.destroy();
});

test("the repository step offers the configured applications and libraries", async () => {
	useProjects([BILLING, BUN_LIB]);
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PATH}
				onKeyReady={() => {}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		{ width: 140, height: 40 },
	);
	const frame = await frameContaining(t, "Billing API");
	expect(frame).toContain("Current directory (dir)");
	expect(frame).toContain("Billing API");
	expect(frame).toContain("/managed/billing");
	expect(frame).toContain("bun-lib-starter");
	// An unusable entry leads its second line with the reason, so the reason
	// survives a row the checkout path would otherwise fill.
	expect(frame).toContain("checkout is missing — /managed/bun-lib-starter");
	expect(frame).toContain("Custom path…");
	t.renderer.destroy();
});

test("the cursor keeps the entry the user chose while the catalog read is in flight", async () => {
	const releaseProjects = useDeferredProjects();
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PATH}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		{ width: 140, height: 40 },
	);
	await t.flush();
	// The read has not landed: the picker offers the opened directory and a path.
	expect(t.captureCharFrame()).not.toContain("Billing API");
	handler?.(key("j")); // park the cursor on the free-path editor
	releaseProjects([BILLING, BUN_LIB]);
	const frame = await frameContaining(t, "Billing API");
	// The catalog arrived above the cursor: the highlight stays on the entry the
	// user chose, so Enter cannot start work in a checkout they never picked.
	expect(frameLine(frame, "Custom path…")).toContain("│");
	expect(frameLine(frame, "Billing API")).not.toContain("│");
	handler?.(key("enter")); // opens the free-path editor
	await t.flush();
	expect(t.captureCharFrame()).not.toContain("Custom path…");
	t.renderer.destroy();
});

test("a catalog read that fails says so, keeps saying so, and leaves the picker usable", async () => {
	useFailingProjects("projects unavailable (500)");
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PATH}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		// A narrow terminal: the notice shares the dialog with the summary table.
		{ width: 80, height: 40 },
	);
	const frame = await frameContaining(t, "Configured projects");
	// The notice wraps over the content column beside the summary table, so the
	// failure *and the reason for it* stay readable even here (~21 columns wide).
	const text = contentText(frame);
	expect(text).toContain(
		"Configured projects could not be read: projects unavailable",
	);
	expect(frame).toContain("Current directory (");
	expect(frame).toContain("Custom path…");
	handler?.(key("j")); // a cursor move must not erase the explanation
	await t.flush();
	expect(contentText(t.captureCharFrame())).toContain(
		"Configured projects could not be read",
	);
	t.renderer.destroy();
});

test("a catalog read the cache superseded is retried, not shown as no projects", async () => {
	let reads = 0;
	configureGateway({
		observe: async (observation: ObservationRequest) => {
			if (observation.kind !== "projects")
				throw new Error(`unexpected ${observation.kind}`);
			reads += 1;
			// An event empties the cache while this read is in flight: the data
			// layer answers `undefined` for the superseded read.
			if (reads === 1) cache.markStale();
			return [BILLING];
		},
	} as unknown as DashboardGateway);
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PATH}
				onKeyReady={() => {}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		{ width: 140, height: 40 },
	);
	const frame = await frameContaining(t, "Billing API");
	expect(reads).toBeGreaterThan(1);
	expect(frame).not.toContain("Configured projects");
	t.renderer.destroy();
});

test("the repository filter matches a checkout path, not only the project name", async () => {
	useProjects([BILLING, BUN_LIB]);
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PATH}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		{ width: 140, height: 40 },
	);
	await frameContaining(t, "Billing API");
	handler?.(key("/"));
	// "managed" is in neither display name: only a path match can keep both
	// projects while dropping the two pathless entries.
	for (const character of "managed") handler?.(key(character));
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Billing API");
	expect(frame).toContain("bun-lib-starter");
	expect(frame).not.toContain("Custom path…");
	expect(frame).not.toContain("Current directory (dir)");
	t.renderer.destroy();
});

test("a filter that matches nothing leaves the picker usable", async () => {
	useProjects([BILLING, BUN_LIB]);
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PATH}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		{ width: 140, height: 40 },
	);
	await frameContaining(t, "Billing API");
	handler?.(key("/"));
	for (const character of "zzz") handler?.(key(character));
	handler?.(key("enter")); // done filtering: the query stays, nothing matches
	await t.flush();
	expect(t.captureCharFrame()).toContain("(0 results)");
	handler?.(key("j")); // an empty list must not park the cursor out of range
	await t.flush();
	handler?.(key("/")); // resume the query and clear it
	for (let index = 0; index < 3; index += 1) handler?.(key("backspace"));
	handler?.(key("enter")); // done filtering
	handler?.(key("enter")); // the cursor is back on the first entry
	await t.flush();
	expect(t.captureCharFrame()).toContain("Openspec apply");
	t.renderer.destroy();
});

test("the repository list filters with a query and submits the chosen path", async () => {
	useProjects([BILLING, BUN_LIB]);
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const completed: NewWorkflowInput[] = [];
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PATH}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async (input) => {
					completed.push(input);
				}}
			/>
		),
		{ width: 140, height: 40 },
	);
	await frameContaining(t, "Billing API");
	handler?.(key("/")); // start filtering
	for (const character of "bill") handler?.(key(character));
	await t.flush();
	const filtered = t.captureCharFrame();
	expect(filtered).toContain("Billing API");
	expect(filtered).not.toContain("bun-lib-starter");
	handler?.(key("enter")); // done filtering: the query and its count stay visible
	await t.flush();
	const query = t.captureCharFrame();
	expect(query).toContain("/bill");
	expect(query).toContain("(1 results)");
	handler?.(key("enter")); // select the only match
	await t.flush();
	expect(t.captureCharFrame()).toContain("Openspec apply");
	handler?.(key("enter")); // workflow type: openspec
	handler?.(key("enter")); // preset: (config defaults)
	t.mockInput.pressEnter(); // ticket: optional
	t.mockInput.pressEnter(); // workflow id
	await t.flush();
	for (const character of "Pick the billing repository")
		t.mockInput.pressKey(character);
	t.mockInput.pressEnter({ meta: true }); // task -> mode
	await t.flush();
	handler?.(key("enter")); // mode: worktree -> confirm
	await t.flush();
	handler?.(key("return")); // create workflow
	await t.flush();
	expect(completed).toHaveLength(1);
	expect(completed[0]).toMatchObject({
		repo: "/managed/billing",
		workflowType: "openspec",
	});
	t.renderer.destroy();
});

test("an unavailable project is refused with its reason instead of starting work there", async () => {
	useProjects([BUN_LIB]);
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PATH}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		// A realistic terminal: the notice shares the dialog with the summary table.
		{ width: 120, height: 40 },
	);
	await frameContaining(t, "bun-lib-starter");
	handler?.(key("j")); // current directory -> bun-lib-starter
	handler?.(key("enter"));
	await t.flush();
	const frame = t.captureCharFrame();
	// The refusal names the reason and the way out, wrapped rather than cut.
	expect(contentText(frame)).toContain(
		"bun-lib-starter is unavailable: checkout is missing. Enter a custom path or pick another entry.",
	);
	// The step did not advance: the picker is still the current field.
	expect(frame).toContain("Custom path…");
	expect(frame).not.toContain("Openspec apply");
	t.renderer.destroy();
});

test("a project context offers every registry workflow type without asking for a repository", async () => {
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PROJECT}
				onKeyReady={() => {}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		{ width: 110, height: 50 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	// The target is the page's project, named once, never chosen.
	expect(frame).toContain("Fixture");
	expect(frame).not.toContain("Custom path");
	expect(frame).not.toContain("Standalone research");
	expect(frame).not.toContain("Current directory");
	expect(frame).toContain("Openspec");
	expect(frame).toContain("Openspec apply");
	expect(frame).toContain("No OpenSpec");
	expect(frame).toContain("Openspec fusion");
	expect(frame).toContain("Openspec Propose Only");
	expect(frame).toContain("Openspec fusion propose");
	expect(frame).toContain("Wiki");
	expect(frame).toContain("Research");
	expect(frame).not.toContain("Wiki Comments");
	t.renderer.destroy();
});

test("an independent Wiki context offers a target-compatible research type only", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const completed: NewWorkflowInput[] = [];
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={INDEPENDENT}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async (input) => {
					completed.push(input);
				}}
			/>
		),
		{ width: 110, height: 40 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Independent (");
	expect(frame).toContain("Research");
	// Repository-bound types and every repository selector are absent.
	expect(frame).not.toContain("Openspec");
	expect(frame).not.toContain("Custom path");
	expect(frame).not.toContain("Standalone research");
	handler?.(key("enter")); // workflow type: research
	handler?.(key("enter")); // agent preset: (config defaults)
	t.mockInput.pressEnter(); // ticket: optional
	t.mockInput.pressEnter(); // workflow id
	await t.flush();
	for (const character of "Survey the wiki") t.mockInput.pressKey(character);
	t.mockInput.pressEnter({ meta: true }); // task -> confirm
	handler?.(key("enter")); // create workflow
	await t.flush();
	expect(completed).toHaveLength(1);
	expect(completed[0]).toMatchObject({
		workflowType: "research",
		repo: "",
		task: "Survey the wiki",
	});
	t.renderer.destroy();
});

test("proposal choices submit their type, task, and fixed checkout mode", async () => {
	for (const [offset, workflowType] of [
		[2, "openspec-propose"],
		[5, "openspec-fusion-propose"],
	] as const) {
		let handler: ((event: KeyEvent) => boolean) | undefined;
		const completed: NewWorkflowInput[] = [];
		const t = await testRender(
			() => (
				<NewWorkflowModal
					context={PROJECT}
					onKeyReady={(h) => {
						handler = h;
					}}
					onCancel={() => {}}
					onComplete={async (input) => {
						completed.push(input);
					}}
				/>
			),
			{ width: 110, height: 30 },
		);
		await t.flush();
		for (let index = 0; index < offset; index++) handler?.(key("j"));
		handler?.(key("enter")); // proposal workflow type
		await t.flush();
		handler?.(key("enter")); // preset
		await t.flush();
		t.mockInput.pressEnter(); // ticket
		await t.flush();
		for (const character of "proposal") t.mockInput.pressKey(character);
		await t.flush();
		const changeFrame = t.captureCharFrame();
		expect(changeFrame.match(/proposal/g)).toHaveLength(2);
		t.mockInput.pressEnter(); // change
		await t.flush();
		for (const character of "Draft only") t.mockInput.pressKey(character);
		await t.flush();
		t.mockInput.pressEnter({ meta: true }); // task -> confirm
		handler?.(key("enter"));
		await t.flush();
		expect(completed).toHaveLength(1);
		expect(completed[0]).toMatchObject({
			workflowType,
			task: "Draft only",
			mode: "checkout",
			repo: PROJECT.repository,
		});
		t.renderer.destroy();
	}
});

test("openspec-apply omits the task step and submits no task", async () => {
	const repo = mkdtempSync(join(tmpdir(), "new-workflow-modal-"));
	mkdirSync(join(repo, "openspec", "changes", "openspec-apply-test"), {
		recursive: true,
	});
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const completed: NewWorkflowInput[] = [];
	try {
		const t = await testRender(
			() => (
				<NewWorkflowModal
					context={{
						kind: "project",
						ident: "fixture",
						name: "Fixture",
						repository: repo,
					}}
					onKeyReady={(h) => {
						handler = h;
					}}
					onCancel={() => {}}
					onComplete={async (input) => {
						completed.push(input);
					}}
				/>
			),
			{ width: 110, height: 30 },
		);
		await t.flush();
		handler?.(key("j")); // standard -> openspec-apply
		handler?.(key("enter")); // select openspec-apply
		await t.flush();
		handler?.(key("enter")); // preset: (config defaults)
		t.mockInput.pressEnter(); // ticket: optional
		handler?.(key("enter")); // change: openspec-apply-test
		handler?.(key("enter")); // mode: worktree
		handler?.(key("enter")); // create workflow
		await t.flush();
		expect(completed).toHaveLength(1);
		expect(completed[0].workflowType).toBe("openspec-apply");
		expect(completed[0].task).toBeUndefined();
		t.renderer.destroy();
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("openspec renders the task step before checkout mode and submits the task", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const completed: NewWorkflowInput[] = [];
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PROJECT}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async (input) => {
					completed.push(input);
				}}
			/>
		),
		{ width: 160, height: 30 },
	);
	await t.flush();
	handler?.(key("enter")); // select the default openspec workflow
	await t.flush();
	// Task-driven fields: preset -> ticket -> workflow id -> task -> mode.
	handler?.(key("enter")); // preset: (config defaults)
	t.mockInput.pressEnter(); // ticket: optional
	t.mockInput.pressEnter(); // workflow id
	await t.flush();
	// The task step is current: the untruncated field label is only rendered
	// here, and the checkout-mode choices do not exist yet.
	const taskFrame = t.captureCharFrame();
	expect(taskFrame).toContain(
		"Task required for wiki, research, and no OpenSpec",
	);
	expect(taskFrame).not.toContain("worktree");
	for (const character of "Classify the JEV plan")
		t.mockInput.pressKey(character);
	await t.flush();
	t.mockInput.pressEnter({ meta: true }); // task -> mode
	await t.flush();
	// The checkout-mode step follows the task step.
	const modeFrame = t.captureCharFrame();
	expect(modeFrame).toContain("Checkout mode");
	expect(modeFrame).toContain("worktree");
	handler?.(key("enter")); // mode: worktree -> confirm
	await t.flush();
	expect(t.captureCharFrame()).toContain("Confirm workflow");
	handler?.(key("return")); // create workflow
	await t.flush();
	expect(completed).toHaveLength(1);
	expect(completed[0]).toMatchObject({
		workflowType: "openspec",
		task: "Classify the JEV plan",
	});
	t.renderer.destroy();
});

test("selecting openspec-fusion submits workflowType openspec-fusion", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const completed: NewWorkflowInput[] = [];
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PROJECT}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async (input) => {
					completed.push(input);
				}}
			/>
		),
		{ width: 160, height: 30 },
	);
	await t.flush();
	handler?.(key("j")); // openspec -> openspec-apply
	handler?.(key("j")); // openspec-apply -> openspec-propose
	handler?.(key("j")); // openspec-propose -> quick
	handler?.(key("j")); // quick -> openspec-fusion
	handler?.(key("enter")); // select openspec-fusion
	await t.flush();
	// openspec-fusion uses the task-driven fields: preset -> ticket -> change -> task -> mode.
	handler?.(key("enter")); // preset: (config defaults)
	t.mockInput.pressEnter(); // ticket: optional
	t.mockInput.pressEnter(); // change
	await t.flush();
	for (const character of "Compare the proposed approaches")
		t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	for (const character of "and recommend one") t.mockInput.pressKey(character);
	await t.flush();
	const taskFrame = t.captureCharFrame();
	expect(taskFrame).toContain("Compare the proposed approaches");
	expect(taskFrame).toContain("and recommend one");
	t.mockInput.pressEnter({ meta: true }); // task: Alt+Enter advances
	handler?.(key("enter")); // mode: worktree
	await t.flush();
	expect(t.captureCharFrame()).toContain("Confirm workflow");
	handler?.(key("return")); // create workflow
	await t.flush();
	expect(completed).toHaveLength(1);
	expect(completed[0].workflowType).toBe("openspec-fusion");
	expect(completed[0].task).toBe(
		"Compare the proposed approaches\nand recommend one",
	);
	t.renderer.destroy();
});

test("creation indicator renders before completion and clears after it settles", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	let resolveComplete: (() => void) | undefined;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PROJECT}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={() =>
					new Promise<void>((resolve) => {
						resolveComplete = resolve;
					})
				}
			/>
		),
		{ width: 110, height: 30 },
	);
	await t.flush();
	handler?.(key("enter")); // workflow type: standard
	handler?.(key("enter")); // preset: (config defaults)
	t.mockInput.pressEnter(); // ticket: optional
	for (const character of "demo") t.mockInput.pressKey(character);
	t.mockInput.pressEnter(); // change
	await t.flush();
	t.mockInput.pressEnter({ meta: true }); // task: Alt+Enter advances
	handler?.(key("enter")); // mode: worktree -> confirm
	await t.flush();
	expect(t.captureCharFrame()).toContain("Confirm workflow");
	handler?.(key("return"));
	await t.flush();
	// The pending indicator is up, and a second Enter cannot submit twice.
	expect(t.captureCharFrame()).toContain("Starting workspace and agents");
	handler?.(key("return"));
	await t.flush();
	resolveComplete?.();
	await t.flush();
	expect(t.captureCharFrame()).not.toContain("Starting workspace and agents");
	t.renderer.destroy();
});
