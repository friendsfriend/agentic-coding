// Herdr sidebar publication boundary tests (improve-herdr-workflow-sidebar,
// task 3.4): successful publication, missing/unsupported API, malformed and
// error responses, oversized and incomplete frames, cancellation, source
// mismatch, and non-secret diagnostics.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HerdrPort } from "../src/workflow/adapters.ts";
import { SIDEBAR_PANE_TOKENS } from "../src/workflow/sidebar.ts";
import { reconcileSidebarOnce } from "../src/workflow/sidebar-observer.ts";
import {
	agentViewClearRequest,
	agentViewSetRequest,
	BoundedSidebarDiagnostics,
	clearSidebarView,
	herdrSocketRequest,
	installSidebarView,
	parseHerdrSocketResponse,
	publishPaneCard,
	publishSidebar,
	readSidebarObservations,
} from "../src/workflow/sidebar-sync.ts";

function fakeHerdr(handlers: Record<string, (args: string[]) => unknown>): {
	herdr: HerdrPort;
	calls: string[][];
} {
	const calls: string[][] = [];
	const herdr: HerdrPort = {
		call(...args: string[]) {
			calls.push(args);
			for (const [prefix, handler] of Object.entries(handlers))
				if (args.slice(0, prefix.split(" ").length).join(" ") === prefix)
					return handler(args);
			return {};
		},
	};
	return { herdr, calls };
}

/** A one-shot unix socket that answers with the given raw bytes. */
async function socketServer(
	reply: (request: string) => string | undefined,
): Promise<{ socketPath: string; stop: () => void; requests: string[] }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-sock-"));
	const socketPath = path.join(dir, "test.sock");
	const requests: string[] = [];
	const server = Bun.listen({
		unix: socketPath,
		socket: {
			data(_socket, data) {
				const text = data.toString();
				requests.push(text);
				const response = reply(text);
				if (response !== undefined) _socket.write(response);
			},
			open() {},
			close() {},
			error() {},
		},
	});
	return { socketPath, stop: () => server.stop(true), requests };
}

describe("sidebar metadata publication", () => {
	test("publishes every owned pane token under this source", async () => {
		const { herdr, calls } = fakeHerdr({});
		await publishPaneCard(herdr, {
			paneId: "w1:p1",
			tokens: {
				[SIDEBAR_PANE_TOKENS.project]: "◆ agentic-coding",
				[SIDEBAR_PANE_TOKENS.rank]: "2",
			},
		});
		expect(calls).toEqual([
			[
				"pane",
				"report-metadata",
				"w1:p1",
				"--source",
				"agentic-coding",
				"--token",
				"ac_project_line=◆ agentic-coding",
				"--token",
				"ac_input_rank=2",
			],
		]);
	});

	test("clears obsolete owned tokens after publishing", async () => {
		const { herdr, calls } = fakeHerdr({});
		await publishSidebar(herdr, {
			panes: [{ paneId: "w1:p1", tokens: { [SIDEBAR_PANE_TOKENS.rank]: "0" } }],
			workspaces: [{ workspaceId: "w1", tokens: { ac_project_line: "◇ p" } }],
			clearedPanes: [{ targetId: "w0:p9", tokens: ["ac_input_rank"] }],
			clearedWorkspaces: [{ targetId: "w0", tokens: ["ac_phase_line"] }],
		});
		expect(calls.map((args) => args.join(" "))).toEqual([
			"pane report-metadata w1:p1 --source agentic-coding --token ac_input_rank=0",
			"workspace report-metadata w1 --source agentic-coding --token ac_project_line=◇ p",
			"pane report-metadata w0:p9 --source agentic-coding --clear-token ac_input_rank",
			"workspace report-metadata w0 --source agentic-coding --clear-token ac_phase_line",
		]);
	});

	test("an unsupported API stays nonfatal with one bounded diagnostic", async () => {
		const messages: string[] = [];
		const diagnostics = new BoundedSidebarDiagnostics((message) =>
			messages.push(message),
		);
		const failing: HerdrPort = {
			call() {
				throw new Error("the 'agent list' subcommand is not supported");
			},
		};
		for (let attempt = 0; attempt < 3; attempt++)
			expect(
				await reconcileSidebarOnce({
					herdr: failing,
					views: () => [],
					diagnostics,
				}),
			).toBeUndefined();
		expect(messages).toEqual([
			"sidebar presentation: the 'agent list' subcommand is not supported",
		]);
	});

	test("a malformed live response fails bounded instead of publishing garbage", async () => {
		const { herdr } = fakeHerdr({ "agent list": () => ({ agents: "nope" }) });
		await expect(readSidebarObservations(herdr)).rejects.toThrow(
			"herdr envelope did not match its schema",
		);
	});

	test("reads live observations, agents, and unmanaged fallbacks in one batch", async () => {
		const { herdr } = fakeHerdr({
			"agent list": () => ({
				agents: [
					{ pane_id: "w1:p1", agent: "pi", agent_status: "blocked" },
					{ pane_id: "w1:p2", agent: "pi", agent_status: "weird" },
				],
			}),
			"pane list": () => ({
				panes: [
					{ pane_id: "w1:p1", workspace_id: "w1", agent_status: "blocked" },
					{
						pane_id: "w9:p1",
						workspace_id: "w9",
						agent_status: "working",
						terminal_title_stripped: "zsh",
						tab_id: "w9:t9",
					},
				],
			}),
			"tab list": () => ({
				tabs: [{ tab_id: "w9:t9", label: "scratch" }],
			}),
			"workspace list": () => ({
				workspaces: [{ workspace_id: "w1", label: "agentic-coding" }],
			}),
		});
		const live = await readSidebarObservations(herdr);
		expect(live.observations).toEqual([
			{ paneId: "w1:p1", status: "blocked", fresh: true },
			{ paneId: "w1:p2", status: "unknown", fresh: true },
		]);
		expect(live.unmanagedPanes).toEqual([
			{
				paneId: "w1:p1",
				workspaceId: "w1",
				label: "w1:p1",
				status: "blocked",
			},
			{
				paneId: "w9:p1",
				workspaceId: "w9",
				label: "zsh",
				status: "working",
				tabLabel: "scratch",
			},
		]);
		expect(live.unmanagedWorkspaces).toEqual([
			{ workspaceId: "w1", label: "agentic-coding" },
		]);
	});

	test("a missing Herdr binary fails as a bounded error, never a crash", async () => {
		const missing: HerdrPort = {
			call() {
				throw new Error("herdr: command not found");
			},
		};
		await expect(readSidebarObservations(missing)).rejects.toThrow(
			"command not found",
		);
	});
});

describe("sidebar socket view transport", () => {
	test("set and clear requests carry this source id and the documented sort", () => {
		const set = JSON.parse(agentViewSetRequest().trim());
		expect(set.method).toBe("agent.view.set");
		expect(set.params.source).toBe("agentic-coding");
		expect(set.params.sort[0]).toEqual({
			field: { token: "ac_input_rank" },
			order: "desc",
		});
		expect(set.params.filter).toBeUndefined();
		const clear = JSON.parse(agentViewClearRequest().trim());
		expect(clear).toEqual({
			id: "agentic-coding-view-clear",
			method: "agent.view.clear",
			params: { source: "agentic-coding" },
		});
	});

	test("parses a result envelope and rejects an error envelope", () => {
		expect(parseHerdrSocketResponse('{"id":"x","result":{"ok":true}}')).toEqual(
			{
				result: { ok: true },
			},
		);
		expect(() =>
			parseHerdrSocketResponse(
				'{"id":"x","error":{"code":"unsupported","message":"no such method"}}',
			),
		).toThrow("herdr socket unsupported: no such method");
		expect(() => parseHerdrSocketResponse("not json")).toThrow(
			"malformed response",
		);
	});

	test("installs the view over a real unix socket", async () => {
		const server = await socketServer(
			() => '{"id":"x","result":{"installed":true}}\n',
		);
		try {
			await installSidebarView({ socketPath: server.socketPath });
			expect(server.requests).toHaveLength(1);
			expect(JSON.parse(server.requests[0]?.trim() ?? "")).toMatchObject({
				method: "agent.view.set",
				params: { source: "agentic-coding" },
			});
		} finally {
			server.stop();
		}
	});

	test("clears the view with the source guard", async () => {
		const server = await socketServer(() => '{"id":"x","result":{}}\n');
		try {
			await clearSidebarView({ socketPath: server.socketPath });
			expect(JSON.parse(server.requests[0]?.trim() ?? "")).toEqual({
				id: "agentic-coding-view-clear",
				method: "agent.view.clear",
				params: { source: "agentic-coding" },
			});
		} finally {
			server.stop();
		}
	});

	test("an error envelope from the server rejects", async () => {
		const server = await socketServer(
			() =>
				'{"id":"x","error":{"code":"conflict","message":"another view is active"}}\n',
		);
		try {
			await expect(
				installSidebarView({ socketPath: server.socketPath }),
			).rejects.toThrow("herdr socket conflict: another view is active");
		} finally {
			server.stop();
		}
	});

	test("an oversized response is rejected", async () => {
		const server = await socketServer(() => `${"x".repeat(200)}\n`);
		try {
			await expect(
				herdrSocketRequest(server.socketPath, "{}\n", { maxBytes: 64 }),
			).rejects.toThrow("exceeded its bound");
		} finally {
			server.stop();
		}
	});

	test("an incomplete frame times out instead of hanging", async () => {
		const server = await socketServer(() => '{"id":"x"');
		try {
			await expect(
				herdrSocketRequest(server.socketPath, "{}\n", { timeoutMs: 50 }),
			).rejects.toThrow("timed out");
		} finally {
			server.stop();
		}
	});

	test("cancellation aborts the exchange and cleans the connection up", async () => {
		const server = await socketServer(() => undefined);
		try {
			const controller = new AbortController();
			const pending = herdrSocketRequest(server.socketPath, "{}\n", {
				signal: controller.signal,
				timeoutMs: 5_000,
			});
			controller.abort();
			await expect(pending).rejects.toThrow("cancelled");
			await expect(
				herdrSocketRequest(server.socketPath, "{}\n", {
					signal: AbortSignal.abort(),
				}),
			).rejects.toThrow("cancelled");
		} finally {
			server.stop();
		}
	});

	test("a missing socket path fails fast without spawning anything", async () => {
		await expect(
			installSidebarView({
				socketPath: path.join(fs.mkdtempSync(os.tmpdir()), "gone.sock"),
			}),
		).rejects.toThrow();
		await expect(installSidebarView({ socketPath: "" })).rejects.toThrow(
			"HERDR_SOCKET_PATH",
		);
	});
});
