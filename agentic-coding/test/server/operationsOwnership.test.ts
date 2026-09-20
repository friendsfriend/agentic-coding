import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Server-owned I/O and event publication (establish-opencode-boundaries,
 * tasks 2.4/2.5): the dashboard's observation implementations live in the
 * backend, the TUI keeps only a transport-or-in-process adapter, and
 * publication crosses the contract event envelope instead of ad-hoc payloads.
 */
const SRC = path.join(import.meta.dir, "..", "..", "src");

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...filesUnder(full));
		else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
	}
	return out;
}

const rel = (file: string) =>
	path.relative(SRC, file).split(path.sep).join("/");

describe("observation I/O ownership", () => {
	test("the dashboard reads through the data layer, not an adapter", () => {
		// the transitional adapter is deleted; feature code reads through
		// tui/data, which owns the cache and depends only on the port
		expect(() =>
			statSync(path.join(SRC, "tui/dash/observations.ts")),
		).toThrow();
		expect(() => statSync(path.join(SRC, "tui/dash/engine.ts"))).toThrow();
		const workflow = readFileSync(
			path.join(SRC, "tui/data/workflow.ts"),
			"utf8",
		);
		expect(workflow).toContain("gateway()");
		expect(workflow).not.toContain("backendClient");
	});

	test("every observation implementation is owned by the server", () => {
		const server = readFileSync(
			path.join(SRC, "server/operations/observations.ts"),
			"utf8",
		);
		for (const fn of [
			"runLocalObservation",
			"loadDashboard",
			"worktreeGitStatus",
			"loadWikiSnapshotChanges",
			"loadLocalChanges",
			"loadVerifierFindings",
			"loadDeveloperReviewFindings",
			"saveDeveloperReview",
		])
			expect(server).toContain(fn);
		// the server implementation never reaches a transport client
		expect(server).not.toContain("backendClient");
	});

	test("a TUI Herdr subscription exists only for the transport-less run", () => {
		// Two files may mention the socket: the server (owner) and the dashboard
		// adapter, which subscribes only when no transport is configured.
		const offenders: string[] = [];
		for (const file of filesUnder(path.join(SRC, "tui"))) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/subscribeHerdrEvents\(/g)) {
				const before = source.slice(
					Math.max(0, match.index - 400),
					match.index,
				);
				// the guard is the shell's transport question: with a gateway the
				// server owns the socket and the shell must not subscribe
				if (
					!before.includes("serverOwnsExecutionEvents()") &&
					!before.includes("backendClient()")
				)
					offenders.push(`${rel(file)}: unconditional Herdr subscription`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("event publication contract", () => {
	test("the Herdr subscription lives behind the server event broker", () => {
		const subscriptions = readFileSync(
			path.join(SRC, "server/subscriptions.ts"),
			"utf8",
		);
		expect(subscriptions).toContain('from "./herdr-events');
		expect(subscriptions).toContain("events.publish");
		// the envelope type is the contract's, not a local shape
		const herdr = readFileSync(
			path.join(SRC, "server/herdr-events.ts"),
			"utf8",
		);
		expect(herdr).toContain('from "../contracts/integration.ts"');
		expect(herdr).not.toMatch(/export interface HerdrEvent/);
		expect(herdr).not.toMatch(/export const HERDR_DASHBOARD_EVENTS/);
	});

	test("published envelopes decode against the contract schema", async () => {
		const { dashboardEventSchema } = await import(
			"../../src/contracts/environment.ts"
		);
		const { decodeContract, ContractFailure } = await import(
			"../../src/contracts/decode.ts"
		);
		const envelope = {
			instance: "server-1",
			sequence: 4,
			domain: "workflow",
			kind: "workflow.updated",
			resource: "/repo",
			at: new Date(0).toISOString(),
			payload: { runId: "run-1" },
		};
		expect(
			decodeContract("core.dashboard-event", dashboardEventSchema, envelope),
		).toMatchObject({ sequence: 4, domain: "workflow" });
		// an unbounded field is refused rather than published
		expect(() =>
			decodeContract("core.dashboard-event", dashboardEventSchema, {
				...envelope,
				kind: "k".repeat(4096),
			}),
		).toThrow(ContractFailure);
	});
});

describe("observational reads stay non-mutating (task 2.4)", () => {
	test("repeated reads write no store, claim no lease and launch nothing", async () => {
		const { execFileSync } = await import("node:child_process");
		const os = await import("node:os");
		const fs = await import("node:fs");
		const ops = await import("../../src/server/operations/observations.ts");

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-readonly-"));
		const repo = path.join(root, "repo");
		fs.mkdirSync(repo);
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "base\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync(
			"git",
			[
				"-c",
				"user.email=t@example.com",
				"-c",
				"user.name=t",
				"commit",
				"-qm",
				"base",
			],
			{ cwd: repo },
		);

		const workflowId = "wf-readonly";
		const read = async () => ({
			git: ops.worktreeGitStatus(repo),
			changes: ops.loadLocalChanges(repo, workflowId),
			findings: ops.loadVerifierFindings(repo, workflowId, "quality-verifier"),
			review: ops.loadDeveloperReviewFindings(repo, workflowId),
			wiki: ops.loadWikiSnapshotChanges(repo, workflowId),
		});

		const first = await read();
		const second = await read();
		expect(second).toEqual(first);

		// no workflow store, no effect lease, no pane/launch record
		expect(fs.existsSync(path.join(repo, ".herdr-workflow"))).toBe(false);
		expect(
			execFileSync("git", ["status", "--porcelain"], { cwd: repo })
				.toString()
				.trim(),
		).toBe("");
		const stray = fs
			.readdirSync(repo)
			.filter((entry) => entry !== ".git" && entry !== "README.md");
		expect(stray).toEqual([]);
	});
});
