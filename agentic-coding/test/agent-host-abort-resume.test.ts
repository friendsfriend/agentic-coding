// The host side of the abort/prompt fix (durable-agent-host): a prompt that
// races an in-flight developer abort is queued instead of being withdrawn, the
// client's `whenBusy` mode decides where the prompt lands, and an aborted run's
// workflow state is reconciled through `workflow resume-run` when the developer
// speaks to that run again.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { HostClient } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

function tempWorkflowDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-abort-"));
}

function writeRunEnv(dir: string, vars: Record<string, string>): string {
	const file = path.join(dir, `${vars.HERDR_RUN_ID ?? "run"}.env`);
	fs.writeFileSync(
		file,
		Object.entries(vars)
			.map(([key, value]) => `${key}='${value}'`)
			.join("\n"),
	);
	return file;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text of every user input committed to the transcript. */
function userTexts(entries: readonly unknown[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || entry.kind !== "pi.user") continue;
		const model = Array.isArray(entry.model) ? entry.model : [];
		const message = isRecord(model[0]) ? model[0] : undefined;
		if (typeof message?.content === "string") texts.push(message.content);
	}
	return texts;
}

/** The queued inbox items of one live-docs frame, as `{mode, text}`. */
function inboxItems(
	value: unknown,
): Array<{ mode: string; text: string }> | undefined {
	if (!isRecord(value)) return undefined;
	const docs = isRecord(value.docs) ? value.docs : undefined;
	const inbox =
		docs && isRecord(docs["pi.inbox"]) ? docs["pi.inbox"] : undefined;
	const items = inbox && Array.isArray(inbox.items) ? inbox.items : undefined;
	if (!items) return undefined;
	return items.flatMap((item) => {
		if (!isRecord(item)) return [];
		const mode = typeof item.mode === "string" ? item.mode : "";
		const content = isRecord(item.content) ? item.content : undefined;
		const text =
			typeof content?.content === "string"
				? content.content
				: typeof item.content === "string"
					? item.content
					: "";
		return [{ mode, text }];
	});
}

/** A shim `agentic-coding` on PATH: it logs every invocation and answers
 * `resume-run` with the state the test wants. Mirrors the dialogue tools' shim
 * so nothing here ever reaches a real workflow store. */
function installAgenticCodingShim(script: string): {
	log: string;
	restore: () => void;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-coding-shim-"));
	const log = path.join(dir, "calls.log");
	fs.writeFileSync(
		path.join(dir, "agentic-coding"),
		script.replace("__LOG__", log),
		{
			mode: 0o700,
		},
	);
	const previous = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
	return {
		log,
		restore: () => {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
		},
	};
}

let restore: (() => void) | undefined;
afterEach(() => {
	restore?.();
	restore = undefined;
});

/** Every `agentic-coding` invocation the shim recorded, or the empty string
 * while the shim was never called. */
function shimCalls(log: string): string {
	try {
		return fs.readFileSync(log, "utf8");
	} catch {
		return "";
	}
}

/** How many times the shim answered a `resume-run` reconcile. */
function resumeCalls(log: string): number {
	return shimCalls(log)
		.split("\n")
		.filter((line) => line.includes("resume-run")).length;
}

interface Fixture {
	readonly host: DurableHost;
	readonly layout: ReturnType<typeof hostLayout>;
	readonly dir: string;
	readonly runId: string;
	readonly faux: ReturnType<typeof fauxProvider>;
}

async function openHost(options: {
	runId: string;
	env?: Record<string, string>;
}): Promise<Fixture> {
	const dir = tempWorkflowDir();
	const layout = hostLayout(dir);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await DurableHost.open({
		layout,
		settings: {},
		globalAgentDir: dir,
		storage: new MemoryStorage(),
		models,
	});
	await host.listen();
	const runEnvPath = writeRunEnv(dir, {
		HERDR_RUN_ID: options.runId,
		...(options.env ?? {}),
	});
	await host.ensureRun({
		runId: options.runId,
		name: `worker-${options.runId}`,
		cwd: dir,
		runEnvPath,
		toolPolicy: "default",
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	});
	return { host, layout, dir, runId: options.runId, faux };
}

async function waitForStatus(
	host: DurableHost,
	runId: string,
	want: "working" | "idle",
): Promise<void> {
	let status = await host.status(runId);
	for (let i = 0; i < 100 && status.status !== want; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		status = await host.status(runId);
	}
	expect(status.status).toBe(want);
}

/** Keep one turn running, so a prompt submitted during it is queued. */
function holdTurnBusy(faux: ReturnType<typeof fauxProvider>): void {
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5" })], {
			stopReason: "toolUse",
		}),
	]);
}

describe("prompts around a developer abort", () => {
	test("a prompt that races the abort is queued instead of withdrawn", async () => {
		const fixture = await openHost({ runId: "run-race" });
		const { host, runId } = fixture;
		try {
			holdTurnBusy(fixture.faux);
			await host.submit(runId, "work", "req-work", "followUp");
			await waitForStatus(host, runId, "working");

			// The developer's abort and their next prompt overlap: the prompt is
			// the developer's, so it must land (queued or as the next turn),
			// never be withdrawn by the abort that was still tearing the turn
			// down.
			const aborting = host.abort(runId);
			const racing = host.submit(
				runId,
				"spoken after the abort",
				"req-race",
				"steer",
			);
			const [, submitted] = await Promise.all([aborting, racing]);
			expect(submitted.submissionId).toBeTruthy();

			await waitForStatus(host, runId, "working");
			const texts = userTexts(await host.entriesForTest(runId));
			expect(texts).toContain("spoken after the abort");
		} finally {
			await host.shutdown();
		}
	});

	test("the client's mode decides whether a queued prompt steers or follows up", async () => {
		const fixture = await openHost({ runId: "run-modes" });
		const { host, runId, layout } = fixture;
		try {
			holdTurnBusy(fixture.faux);
			await host.submit(runId, "work", "req-work", "followUp");
			await waitForStatus(host, runId, "working");

			const client = new HostClient(layout.socketPath, 10_000);
			const frames: unknown[] = [];
			const stop = await client.watch(runId, (value) => frames.push(value), {
				view: "docs",
			});
			try {
				// An overwrite interrupts the running turn; a mode this build does
				// not know is still accepted, as an ordinary follow-up.
				await client.submit(
					runId,
					"replace that",
					"req-overwrite",
					"overwrite",
				);
				await client.submit(runId, "queue that", "req-unknown", "mystery-mode");
				let queued: Array<{ mode: string; text: string }> = [];
				for (let i = 0; i < 100 && queued.length < 2; i++) {
					const latest = [...frames]
						.reverse()
						.map((frame) => inboxItems(frame))
						.find((items) => items && items.length >= 2);
					if (latest) queued = latest;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				expect(queued.map((item) => item.mode)).toEqual(["steer", "followUp"]);
				expect(queued.map((item) => item.text)).toEqual([
					"replace that",
					"queue that",
				]);
			} finally {
				stop();
			}
		} finally {
			await host.shutdown();
		}
	});

	test("a prompt to an aborted run reconciles its workflow state once", async () => {
		const shim = installAgenticCodingShim(
			[
				"#!/bin/sh",
				'printf \'%s\\n\' "$*" >> "__LOG__"',
				'case "$*" in',
				'  *resume-run*) printf \'{"runId":"run-resume","workflowId":"wf","state":"resumed"}\\n\' ;;',
				"esac",
				"exit 0",
			].join("\n"),
		);
		restore = shim.restore;
		const fixture = await openHost({
			runId: "run-resume",
			env: { HERDR_RUN_TOKEN: "token" },
		});
		const { host, runId, layout } = fixture;
		try {
			fixture.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
			await host.submit(runId, "work", "req-work", "followUp");
			await waitForStatus(host, runId, "idle");
			// The first prompt of a run asks the engine once: a park can outlive the
			// host that recorded it (a restart, or an older build's park).
			expect(resumeCalls(shim.log)).toBe(1);

			const client = new HostClient(layout.socketPath, 10_000);
			const answer = await client.submit(runId, "again", "req-again", "steer");
			// Nothing new to reconcile, so the prompt does not pay for a second
			// call and reports no state.
			expect(resumeCalls(shim.log)).toBe(1);
			expect(answer.workflowState).toBeUndefined();

			await client.abort(runId);
			const invoked = shimCalls(shim.log);
			expect(invoked).toContain("workflow handoff --outcome blocked --aborted");
			expect(invoked).toContain("aborted by the developer");

			const response = await client.submit(
				runId,
				"back to work",
				"req-after-abort",
				"steer",
			);
			expect(response.workflowState).toBe("resumed");
			expect(shimCalls(shim.log)).toContain("workflow resume-run");
			expect(resumeCalls(shim.log)).toBe(2);
		} finally {
			await host.shutdown();
		}
	});

	test("a run that already handed off reports it instead of reopening", async () => {
		const shim = installAgenticCodingShim(
			[
				"#!/bin/sh",
				'printf \'%s\\n\' "$*" >> "__LOG__"',
				'case "$*" in',
				'  *resume-run*) printf \'{"runId":"run-done","workflowId":"wf","state":"finished","reason":"run is completed"}\\n\' ;;',
				"esac",
				"exit 0",
			].join("\n"),
		);
		restore = shim.restore;
		const fixture = await openHost({
			runId: "run-done",
			env: { HERDR_RUN_TOKEN: "token" },
		});
		const { host, runId, layout } = fixture;
		try {
			fixture.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
			await host.submit(runId, "work", "req-work", "followUp");
			await waitForStatus(host, runId, "idle");
			await host.abort(runId);

			const client = new HostClient(layout.socketPath, 10_000);
			const response = await client.submit(runId, "still there?", "req-late");
			// Reported, never silently reopened: the message still reaches the
			// session, and the state the engine refused to change is named.
			expect(response.workflowState).toBe("finished");
			expect(response.workflowNote).toBe("run is completed");
			expect(userTexts(await host.entriesForTest(runId))).toContain(
				"still there?",
			);
		} finally {
			await host.shutdown();
		}
	});
});
