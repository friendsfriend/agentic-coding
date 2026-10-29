/** @jsxImportSource @opentui/solid */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobInput, ScheduleInput } from "../src/contracts/scheduling.ts";
import type { SchedulingRequest } from "../src/contracts/scheduling-api.ts";
import type { SchedulingTargetAdapter } from "../src/server/scheduling/adapters.ts";

// Import application modules only after installing an entirely disposable home.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-ui-"));
const isolation = {
	HOME: sandbox,
	AGENTIC_CODING_CONFIG_DIR: path.join(sandbox, "config"),
	PI_CODING_AGENT_DIR: path.join(sandbox, "pi"),
	HERDR_WIKI_DIR: path.join(sandbox, "wiki"),
};
const previous = new Map(
	Object.keys(isolation).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, isolation);
const { createDefaultOpenTuiKeymap } = await import("@opentui/keymap/opentui");
const { testRender, useRenderer } = await import("@opentui/solid");
const { onCleanup } = await import("solid-js");
const { App } = await import("../src/tui/otel/app/App.tsx");
const { TraceDb } = await import("../src/server/telemetry-db.ts");
const { TraceStore } = await import("../src/tui/otel/model/traceStore.ts");
const { MetricStore } = await import("../src/tui/otel/model/metricStore.ts");
const { LogStore } = await import("../src/tui/otel/model/logStore.ts");
const { TopologyStore } = await import(
	"../src/tui/otel/model/topologyStore.ts"
);
const { configureBackendClient, clearBackendClient } = await import(
	"../src/server/client.ts"
);
const { SchedulingStore } = await import("../src/server/scheduling/store.ts");
const { SchedulingService } = await import(
	"../src/server/scheduling/service.ts"
);
const { SchedulingApi } = await import("../src/server/scheduling/api.ts");
const { createServerApp } = await import("../src/server/app.ts");
const { createInstanceAuthority } = await import("../src/server/auth.ts");
const { CredentialRegistry } = await import("../src/server/credentials.ts");
const { EventBroker } = await import("../src/server/events.ts");
const { schedulingRequestSchema } = await import(
	"../src/contracts/scheduling-api.ts"
);
const { decodeScheduling } = await import("../src/contracts/scheduling.ts");
const cleanups: Array<() => void | Promise<void>> = [];
const evidence: string[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(() => {
	clearBackendClient();
	for (const [key, value] of previous) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (process.env.SCHEDULING_UI_EVIDENCE === "1")
		fs.writeFileSync(
			process.env.SCHEDULING_UI_EVIDENCE_PATH ??
				path.resolve(import.meta.dir, "../.scheduling-ui-evidence.log"),
			evidence.join("\n\n"),
			{ mode: 0o600 },
		);
	fs.rmSync(sandbox, { recursive: true, force: true });
});
const sleep = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture() {
	const root = fs.mkdtempSync(path.join(sandbox, "store-")),
		store = SchedulingStore.open(root);
	let now = Date.parse("2026-01-01T00:00:00Z"),
		bootstraps = 0,
		loseAck = false;
	const adapter: SchedulingTargetAdapter = {
		resolve: async (job) => job,
		reserve: async (value) => ({
			id: value.id,
			digest: "fixture",
			state: "reserved",
		}),
		activate: async (value) => ({
			...(value.receipt ?? { id: value.id, digest: "fixture" }),
			state: "succeeded",
			result: "The exact scheduled fixture output.",
		}),
		query: async (value) => {
			if (!value.receipt) throw new Error("Missing fixture receipt");
			return value.receipt;
		},
	};
	const service = new SchedulingService(
		store,
		{ "wake-up": adapter, standalone: adapter, workflow: adapter },
		() => now,
	);
	const api = new SchedulingApi(service, async () => {
		bootstraps++;
		return {
			kind: "wake-up",
			hostId: "fixture-host",
			hostSocket: "fixture-socket",
			runId: "fixture-run",
			conversationId: "fixture-conversation",
		};
	});
	const authority = createInstanceAuthority("scheduling-ui", "fixture-token"),
		app = createServerApp({
			authority,
			events: new EventBroker(authority.instance),
			credentials: new CredentialRegistry(),
			scheduling: api,
		});
	let activeApp = app;
	const requests: SchedulingRequest[] = [];
	const listener = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) => {
			let body: SchedulingRequest | undefined;
			if (
				new URL(request.url).pathname === "/api/v1/scheduling" &&
				request.method === "POST"
			) {
				body = decodeScheduling(
					schedulingRequestSchema,
					await request.clone().json(),
				);
				requests.push(body);
			}
			const response = await activeApp.fetch(request);
			if (loseAck && body?.operation === "create" && response.ok) {
				loseAck = false;
				return new Response("fixture: acknowledgement lost after commit", {
					status: 502,
				});
			}
			return response;
		},
	});
	service.start();
	cleanups.push(async () => {
		await service.stop();
		await listener.stop(true);
		store.close();
	});
	return {
		store,
		service,
		api,
		app,
		url: `http://127.0.0.1:${listener.port}`,
		token: authority.token,
		requests,
		bootstraps: () => bootstraps,
		advance: (ms: number) => {
			now += ms;
		},
		loseAck: () => {
			loseAck = true;
		},
		replace: (replacement: typeof app) => {
			activeApp = replacement;
		},
	};
}
async function renderShell(
	f: ReturnType<typeof fixture>,
	kittyKeyboard = false,
	width = 140,
) {
	configureBackendClient({
		baseUrl: f.url,
		token: f.token,
		ownerId: "scheduling-manual-journey",
	});
	const db = new TraceDb(fs.mkdtempSync(path.join(sandbox, "telemetry-")));
	const t = await testRender(
		() => {
			const keymap = createDefaultOpenTuiKeymap(useRenderer());
			const dispose = keymap.registerLayerFields({
				appView: (value, ctx) => ctx.require("app.view", String(value)),
				activeModal: (value, ctx) => ctx.require("modal.active", String(value)),
				agentView: (value, ctx) => ctx.require("agent.view", String(value)),
				textEntry: (value, ctx) =>
					ctx.require("textEntry.active", Boolean(value)),
			});
			keymap.setData("app.view", "home");
			keymap.setData("modal.active", "none");
			onCleanup(dispose);
			return (
				<App
					repos={[]}
					db={db}
					traceStore={new TraceStore()}
					metricStore={new MetricStore()}
					logStore={new LogStore()}
					topologyStore={new TopologyStore()}
					dashboard={{ mode: "home", keymap }}
				/>
			);
		},
		{ width, height: 40, kittyKeyboard },
	);
	cleanups.push(() => {
		t.renderer.destroy();
		db.close();
		clearBackendClient();
	});
	await t.renderOnce();
	return t;
}
type Terminal = Awaited<ReturnType<typeof renderShell>>;
async function frameWhere(
	t: Terminal,
	predicate: (frame: string) => boolean,
	label = "frame",
) {
	for (let n = 0; n < 150; n++) {
		await t.renderOnce();
		const frame = t.captureCharFrame();
		if (predicate(frame.replace(/\s+/g, " "))) return frame;
		await sleep();
	}
	const frame = t.captureCharFrame();
	evidence.push(`${label}: FAILED\n${frame}`);
	throw new Error(`${label} did not appear\n${frame}`);
}
async function press(t: Terminal, key: string, ctrl = false) {
	if (key === "enter") t.mockInput.pressEnter({ ctrl });
	else if (key === "escape") t.mockInput.pressEscape();
	else if (key === "f2") t.mockInput.pressKey("F2");
	else if (key === "tab") t.mockInput.pressKey("TAB", { ctrl });
	else if (key === "backspace") t.mockInput.pressKey("BACKSPACE", { ctrl });
	else t.mockInput.pressKey(key, { ctrl });
	await sleep();
	await t.renderOnce();
}
async function text(t: Terminal, value: string) {
	for (const character of value) t.mockInput.pressKey(character);
	await sleep();
	await t.renderOnce();
}
async function navigate(t: Terminal, destination: string, marker: string) {
	await press(t, "p", true);
	await frameWhere(
		t,
		(frame) => frame.includes("Locations"),
		"location picker",
	);
	await text(t, destination);
	await press(t, "enter");
	return frameWhere(t, (frame) => frame.includes(marker), destination);
}
async function fill(t: Terminal, value: string) {
	await press(t, "enter");
	await press(t, "u", true);
	await text(t, value);
	await press(t, "escape");
}
async function move(t: Terminal, count: number) {
	for (let i = 0; i < count; i++) await press(t, "j");
}

test("task editor keeps multiline and long-line caret visible and selects invalid fields", async () => {
	const f = fixture(),
		t = await renderShell(f, true, 90);
	await navigate(t, "schedules", "Service running");
	await press(t, "n");
	await fill(t, "Visible editor");
	await move(t, 3);
	await press(t, "enter");
	await text(t, "first line");
	await press(t, "enter");
	await text(t, "second visible line");
	let frame = await frameWhere(
		t,
		(frame) => frame.includes("second visible line▌"),
		"multiline caret",
	);
	expect(frame).toContain("first line");
	await text(t, `${"x".repeat(350)}TAIL`);
	frame = await frameWhere(
		t,
		(frame) => frame.includes("TAIL▌"),
		"long line caret",
	);
	expect(frame).toContain("TAIL▌");
	await press(t, "escape");
	await press(t, "enter", true);
	frame = await frameWhere(
		t,
		(frame) => frame.includes("Draft retained") && frame.includes("job.name"),
		"field validation",
	);
	expect(frame).toContain("⚠");
	expect(f.store.listJobs()).toHaveLength(0);
	await fill(t, "Corrected name");
	await press(t, "enter", true);
	await frameWhere(
		t,
		(frame) => frame.includes("hostId"),
		"next invalid destination field",
	);
});

test("manual shell restores drafts and renders the real footer and full help contract", async () => {
	const f = fixture(),
		t = await renderShell(f);
	const list = await navigate(t, "schedules", "Service running");
	evidence.push(`Schedules footer\n${list}`);
	expect(list).toContain("new");
	expect(list).not.toContain("Ctrl+S save");
	await press(t, "?");
	const help = await frameWhere(
		t,
		(frame) =>
			frame.includes("Keybindings") && frame.includes("Create schedule"),
		"schedule help",
	);
	evidence.push(`Schedules help\n${help}`);
	expect(help).toContain("Move selection");
	await press(t, "escape");
	await press(t, "n");
	await frameWhere(
		t,
		(frame) => frame.includes("Schedule name"),
		"schedule editor",
	);
	await fill(t, "Restored manual draft");
	await navigate(t, "home", "Home");
	const restored = await navigate(t, "schedules", "Restored manual draft");
	expect(restored).toContain("Schedule name");
	expect(restored).not.toContain("Esc to finish editing");
	await press(t, "?");
	const editorHelp = await frameWhere(
		t,
		(frame) => frame.includes("Preview and save"),
		"editor help",
	);
	evidence.push(`Editor help\n${editorHelp}`);
	expect(editorHelp).toContain("Ctrl+Enter");
	expect(editorHelp).not.toContain("Shift+N");
	await press(t, "escape");
	expect(f.store.listJobs()).toHaveLength(0);
	expect(f.bootstraps()).toBe(0);
});

test("lost acknowledgements survive page changes and a rejected replay cannot erase uncertainty", async () => {
	const f = fixture(),
		t = await renderShell(f, true);
	await navigate(t, "schedules", "Service running");
	await press(t, "n");
	await frameWhere(t, (frame) => frame.includes("Schedule name"), "editor");
	await fill(t, "Manual reminder");
	await move(t, 2);
	await fill(t, "Reusable fixture job");
	await move(t, 1);
	await fill(t, "Check the isolated fixture and report.");
	await move(t, 6);
	await press(t, "enter");
	await frameWhere(t, () => f.bootstraps() === 1, "destination initialization");
	await press(t, "enter", true);
	await frameWhere(
		t,
		(frame) => frame.includes("Save scheduling changes"),
		"timing preview confirmation",
	);
	f.loseAck();
	await press(t, "enter");
	await frameWhere(
		t,
		(frame) => frame.includes("Retry retains the exact request"),
		"lost acknowledgement",
	);
	expect(f.store.listJobs()).toHaveLength(1);
	const originalDue = f.store.listSchedules()[0]?.timing;
	await navigate(t, "home", "Home");
	await navigate(t, "schedules", "Save scheduling changes");
	const replacement = fixture();
	f.replace(replacement.app);
	await press(t, "enter");
	await frameWhere(
		t,
		(frame) =>
			frame.includes("acknowledgement") && frame.includes("still unknown"),
		"rejected replay preserves uncertainty",
	);
	await press(t, "escape");
	await frameWhere(
		t,
		(frame) => frame.includes("Save scheduling changes"),
		"cannot discard unknown acknowledgement",
	);
	expect(replacement.store.listJobs()).toHaveLength(0);
	f.replace(f.app);
	await press(t, "enter");
	const saved = await frameWhere(
		t,
		(frame) => frame.includes("Saved · request"),
		"replayed acknowledgement",
	);
	evidence.push(`Acknowledgement recovery\n${saved}`);
	expect(f.store.listJobs()).toHaveLength(1);
	expect(f.store.listSchedules()).toHaveLength(1);
	expect(f.store.listSchedules()[0]?.timing).toEqual(originalDue);
	expect(f.bootstraps()).toBe(1);
	const attempts = f.requests.filter(
		(request) => request.operation === "create",
	);
	expect(attempts).toHaveLength(3);
	expect(attempts[1]).toEqual(attempts[0]);
	expect(attempts[2]).toEqual(attempts[0]);
	await press(t, "R");
	await frameWhere(
		t,
		(frame) => frame.includes("Run now"),
		"run-now confirmation",
	);
	await press(t, "enter");
	await f.service.tick();
	await press(t, "r");
	await press(t, "o");
	const output = await frameWhere(
		t,
		(frame) => frame.includes("The exact scheduled fixture output."),
		"read-only exact output",
	);
	evidence.push(`Read-only exact output\n${output}`);
	expect(output).toContain("read-only");
}, 15000);

function seedManual(
	f: ReturnType<typeof fixture>,
	target: JobInput["target"],
	timing: ScheduleInput["timing"],
) {
	const job = f.store.createJob(
		{
			name: "UI fixture job",
			task: "Observe fixture only.",
			originalInstruction: "Observe later",
			reason: "Manual fixture",
			references: [],
			reportingDestination: "transcript",
			target,
		},
		Date.parse("2026-01-01T00:00:00Z"),
	);
	return f.store.createSchedule(
		{
			name: "UI fixture schedule",
			jobId: job.id,
			timing,
			latePolicy: { kind: "run-late" },
		},
		Date.parse("2026-01-01T00:00:00Z"),
	);
}
const manualWake: JobInput["target"] = {
	kind: "wake-up",
	hostId: "fixture-host",
	hostSocket: "fixture-socket",
	runId: "fixture-run",
	conversationId: "fixture-conversation",
};
test("legacy F2 works at narrow width; history filtering keeps its scope and unavailable status stays honest", async () => {
	const f = fixture();
	seedManual(f, manualWake, {
		kind: "once",
		at: "2030-01-01T00:00:00.000Z",
		timezone: "UTC",
	});
	const t = await renderShell(f, false, 80);
	await navigate(t, "schedules", "UI fixture schedule");
	const list = await frameWhere(
		t,
		(frame) => frame.includes("P postpone") && frame.includes("R run"),
		"wrapped narrow footer",
	);
	evidence.push(`Narrow footer\n${list}`);
	await press(t, "e");
	await frameWhere(
		t,
		(frame) => frame.includes("Schedule name"),
		"manual editor",
	);
	await press(t, "f2");
	await frameWhere(
		t,
		(frame) => frame.includes("Save scheduling changes"),
		"legacy F2 confirmation",
	);
	await press(t, "enter");
	await frameWhere(t, (frame) => frame.includes("Saved"), "saved schedule");
	expect(
		f.requests.some((request) => request.operation === "schedules.update"),
	).toBe(true);
	await press(t, "R");
	await frameWhere(t, (frame) => frame.includes("Run now"), "run-now review");
	await press(t, "enter");
	await frameWhere(t, (frame) => frame.includes("Saved"), "run-now saved");
	await f.service.tick();
	await press(t, "h");
	await frameWhere(
		t,
		(frame) =>
			frame.includes("Occurrence history") && frame.includes("succeeded"),
		"terminal history",
	);
	await press(t, "f");
	await text(t, "Ω");
	await frameWhere(
		t,
		(frame) => frame.includes("No items"),
		"empty scoped filter",
	);
	await press(t, "backspace");
	await text(t, "succeeded");
	await press(t, "enter");
	const history = await frameWhere(
		t,
		(frame) =>
			frame.includes("Occurrence history") && frame.includes("succeeded"),
		"filter returns to history",
	);
	evidence.push(`Filtered history\n${history}`);
	await f.service.stop();
	await press(t, "r");
	const unavailable = await frameWhere(
		t,
		(frame) => frame.includes("Service unavailable"),
		"stopped service status",
	);
	evidence.push(`Unavailable status\n${unavailable}`);
}, 15000);

const manualScenarios: {
	target: JobInput["target"];
	timing: ScheduleInput["timing"];
}[] = [
	{
		target: {
			kind: "standalone",
			repository: "/fixture/repository",
			baseBranch: "main",
			model: "fixture/model",
			policy: "read-only",
			reviewPolicy: "none",
		},
		timing: {
			kind: "calendar",
			timezone: "Europe/Berlin",
			weekdays: [1, 3],
			hour: 9,
			minute: 30,
		},
	},
	{
		target: {
			kind: "workflow",
			repository: "/fixture/repository",
			workflowType: "feature",
			preset: "fixture",
			mode: "worktree",
			sourceBranch: "main",
		},
		timing: {
			kind: "interval",
			timezone: "UTC",
			anchor: "2026-01-01T00:00:00.123Z",
			everyMs: 123456,
		},
	},
];
for (const scenario of manualScenarios)
	test(`manual ${scenario.target.kind} fields and ${scenario.timing.kind} timing round-trip through the shared client`, async () => {
		const f = fixture();
		const seeded = seedManual(f, scenario.target, scenario.timing);
		const t = await renderShell(f);
		await navigate(t, "schedules", "UI fixture schedule");
		await press(t, "e");
		await frameWhere(
			t,
			(frame) => frame.includes("Schedule name"),
			"timing editor",
		);
		await press(t, "f2");
		await frameWhere(
			t,
			(frame) => frame.includes("Save scheduling changes"),
			"timing preview",
		);
		await press(t, "enter");
		// Saving starts a follow-up list refresh. Wait for that refresh before
		// adding an external row and sending another refresh key: busy views
		// intentionally ignore keys, and the acknowledgement alone is not idle.
		await frameWhere(
			t,
			(frame) => frame.includes("Saved") && !frame.includes(" · loading"),
			"timing saved and refreshed",
		);
		const update = f.requests.find(
			(request) => request.operation === "schedules.update",
		);
		if (update?.operation !== "schedules.update")
			throw new Error("Missing shared-client schedule update");
		expect(update.schedule.timing).toEqual(scenario.timing);
		f.store.createSchedule(
			{
				name: "External fixture schedule",
				jobId: seeded.jobId,
				timing: scenario.timing,
				latePolicy: { kind: "run-late" },
			},
			Date.parse("2030-01-01T00:00:00Z"),
		);
		const gets = f.requests.filter(
			(request) => request.operation === "schedules.get",
		).length;
		await press(t, "r");
		await frameWhere(
			t,
			(frame) =>
				frame.includes("External fixture schedule") &&
				f.requests.filter((request) => request.operation === "schedules.get")
					.length > gets,
			"refresh retains selection by ID",
		);
		expect(
			f.requests
				.filter((request) => request.operation === "schedules.get")
				.at(-1)?.id,
		).toBe(seeded.id);
		await press(t, "tab");
		await frameWhere(t, (frame) => frame.includes("Reusable jobs"), "job list");
		await press(t, "e");
		await frameWhere(t, (frame) => frame.includes("Job name"), "job editor");
		let fields = t.captureCharFrame();
		for (
			let step = 0;
			step < 24 && !fields.toLowerCase().includes(scenario.target.kind);
			step++
		) {
			await press(t, "j");
			fields = t.captureCharFrame();
		}
		expect(fields.toLowerCase()).toContain(scenario.target.kind);
		evidence.push(`${scenario.target.kind} target form\n${fields}`);
	}, 15000);

for (const action of [
	"pause",
	"resume",
	"cancel",
	"delete",
	"run-now",
	"postpone",
] as const) {
	test(`manual ${action} confirms before mutation and preserves an admitted review wait`, async () => {
		const f = fixture(),
			schedule = seedManual(f, manualWake, {
				kind: "once",
				at: "2030-01-01T00:00:00.000Z",
				timezone: "UTC",
			});
		const now = Date.parse("2026-01-01T00:00:00Z");
		const { occurrence } = f.store.action(
			schedule.id,
			1,
			"run-now",
			now,
			"setup",
		);
		if (!occurrence) throw new Error("Missing review occurrence");
		const claim = f.store.claim(occurrence.id, now);
		if (!claim) throw new Error("Missing claim");
		f.store.transition(claim.id, claim.fence, "reserved", now, {
			receipt: { id: claim.id, digest: "fixture", state: "reserved" },
		});
		f.store.authorize(claim.id, claim.fence, now);
		f.store.transition(claim.id, claim.fence, "waiting-review", now, {
			receipt: { id: claim.id, digest: "fixture", state: "waiting-review" },
		});
		if (action === "resume")
			f.store.action(
				schedule.id,
				f.store.schedule(schedule.id).revision,
				"pause",
				now,
				"setup-pause",
			);
		const before = f.store.schedule(schedule.id);
		const t = await renderShell(f);
		await navigate(t, "schedules", "UI fixture schedule");
		const key =
			action === "pause" || action === "resume"
				? "p"
				: action === "cancel"
					? "c"
					: action === "delete"
						? "x"
						: action === "run-now"
							? "R"
							: "P";
		const label = {
			"run-now": "Run now",
			postpone: "Postpone next run",
			pause: "Pause",
			resume: "Resume",
			cancel: "Cancel",
			delete: "Delete",
		}[action];
		const review = async () => {
			await press(t, key);
			if (action === "postpone") await press(t, "enter");
			return frameWhere(
				t,
				(frame) => frame.includes(label),
				"action confirmation",
			);
		};
		await review();
		expect(
			f.requests.some((request) => request.operation === "schedules.action"),
		).toBe(false);
		await press(t, "escape");
		if (action === "postpone") await press(t, "escape");
		expect(f.store.schedule(schedule.id).revision).toBe(before.revision);
		await review();
		await press(t, "enter");
		const saved = await frameWhere(
			t,
			(frame) => frame.includes("Saved"),
			"action committed",
		);
		evidence.push(`${action} confirmed\n${saved}`);
		const request = f.requests.find(
			(request) => request.operation === "schedules.action",
		);
		expect(
			request?.operation === "schedules.action" ? request.action : undefined,
		).toBe(action);
		expect(f.store.schedule(schedule.id).revision).toBe(
			before.revision + (action === "run-now" ? 0 : 1),
		);
		expect(f.store.occurrence(claim.id).admittedAt).toBe(now);
		expect(f.store.occurrence(claim.id).state).toBe("waiting-review");
		if (action === "run-now")
			expect(
				f.store
					.history(schedule.id)
					.some((value) => value.state === "skipped-overlap"),
			).toBe(true);
	}, 15000);
}
test("a stale editor confirmation retains the draft and reloads the external revision", async () => {
	const f = fixture(),
		schedule = seedManual(f, manualWake, {
			kind: "once",
			at: "2030-01-01T00:00:00.000Z",
			timezone: "UTC",
		}),
		t = await renderShell(f);
	await navigate(t, "schedules", "UI fixture schedule");
	await press(t, "e");
	await frameWhere(t, (frame) => frame.includes("Schedule name"), "editor");
	await fill(t, "Retained draft");
	await press(t, "f2");
	await frameWhere(
		t,
		(frame) => frame.includes("Save scheduling changes"),
		"stale preview",
	);
	f.store.updateSchedule(
		schedule.id,
		1,
		{
			name: "External revision",
			jobId: schedule.jobId,
			timing: schedule.timing,
			latePolicy: schedule.latePolicy,
		},
		Date.parse("2026-01-01T00:00:01Z"),
	);
	await press(t, "enter");
	await frameWhere(
		t,
		(frame) => frame.includes("Reload the saved version"),
		"stale conflict",
	);
	expect(f.store.schedule(schedule.id).name).toBe("External revision");
	await press(t, "escape");
	await frameWhere(
		t,
		(frame) => frame.includes("Retained draft"),
		"retained stale draft",
	);
	await press(t, "escape");
	await press(t, "r");
	await frameWhere(
		t,
		(frame) => frame.includes("External revision"),
		"external reload",
	);
	await press(t, "e");
	await frameWhere(
		t,
		(frame) => frame.includes("External revision"),
		"current editor",
	);
}, 15000);

test("editing a reused job confirms its complete fan-out before changing future settings", async () => {
	const f = fixture(),
		first = seedManual(f, manualWake, {
			kind: "once",
			at: "2030-01-01T00:00:00.000Z",
			timezone: "UTC",
		});
	const second = f.store.createSchedule(
		{
			name: "Second fixture schedule",
			jobId: first.jobId,
			timing: first.timing,
			latePolicy: first.latePolicy,
		},
		Date.parse("2026-01-01T00:00:00Z"),
	);
	const t = await renderShell(f);
	await navigate(t, "schedules", "UI fixture schedule");
	await press(t, "tab");
	await frameWhere(
		t,
		(frame) => frame.includes("Reusable jobs"),
		"reusable jobs",
	);
	await press(t, "e");
	await frameWhere(
		t,
		(frame) => frame.includes("Job name"),
		"shared-job editor",
	);
	await fill(t, "Updated shared job");
	await press(t, "f2");
	await frameWhere(
		t,
		(frame) => frame.includes("Save scheduling changes"),
		"fan-out confirmation",
	);
	expect(
		f.requests.some((request) => request.operation === "jobs.update"),
	).toBe(false);
	await press(t, "enter");
	await frameWhere(t, (frame) => frame.includes("Saved"), "shared-job commit");
	const request = f.requests.find(
		(request) => request.operation === "jobs.update",
	);
	if (request?.operation !== "jobs.update")
		throw new Error("Missing shared-job request");
	expect(request.affectedSchedules).toEqual([first.id, second.id].sort());
	expect(f.store.job(first.jobId).name).toBe("Updated shared job");
}, 15000);
