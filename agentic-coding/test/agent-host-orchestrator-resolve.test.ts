// The cheap wake-up surface (efficiency backlog item 21): one identifier across
// the workflow tools, a keyed multi-id `workflow_status` poll with a per-id
// revision, a candidate answer for an unknown id, the change listing, and
// `start_workflow` taking a task by reference. The tools run against a real
// loopback server whose operations are stubbed, so the wire contract (including
// the task/taskRef refusal) is exercised, not bypassed.
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createOrchestratorExtension } from "../src/agent-host/orchestrator.ts";
import { compactWorkflowStatus } from "../src/agent-host/orchestrator-compact.ts";
import {
	ORCHESTRATOR_TOKEN_ENV,
	ORCHESTRATOR_URL_ENV,
} from "../src/agent-host/orchestrator-env.ts";
import {
	decodeSinceRevisions,
	decodeWorkflowIds,
	rankSimilarIds,
} from "../src/agent-host/orchestrator-resolve.ts";
import {
	type WorkflowStartRequest,
	workflowStartRequestSchema,
} from "../src/contracts/actions.ts";
import { orchestratorTokenFor } from "../src/server/auth.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";

interface ToolResult {
	readonly content: Array<{ type: string; text: string }>;
	readonly isError?: boolean;
}

interface Tool {
	readonly name: string;
	readonly description: string;
	readonly parameters: {
		properties: Record<string, { anyOf?: { type?: string }[] }>;
	};
	execute(
		args: Record<string, unknown>,
		api: { conversationId: string },
	): Promise<ToolResult>;
}

const call = (tool: Tool, args: Record<string, unknown> = {}) =>
	tool.execute(args, { conversationId: "orchestrator" });

const json = (result: ToolResult | undefined): unknown =>
	JSON.parse(result?.content[0]?.text ?? "null");

/** The tools of one orchestrator session, wired to `url` with the capability
 * the run's environment carries. `lastDeveloperMessage` is what the host records
 * from the developer's own submissions. */
function toolsFor(
	url: string,
	token: string,
	options: { lastDeveloperMessage?: string } = {},
): Map<string, Tool> {
	const lookup = (() => ({
		runId: "run-1",
		cwd: process.cwd(),
		env: {
			[ORCHESTRATOR_URL_ENV]: url,
			[ORCHESTRATOR_TOKEN_ENV]: orchestratorTokenFor(token),
		},
		...(options.lastDeveloperMessage === undefined
			? {}
			: {
					lastDeveloperMessage: () => options.lastDeveloperMessage,
				}),
	})) as unknown as Parameters<typeof createOrchestratorExtension>[0];
	const extension = createOrchestratorExtension(lookup) as unknown as {
		tools: Tool[];
	};
	return new Map(extension.tools.map((tool) => [tool.name, tool]));
}

/** One workflow view: the fields the compact row reads, nothing more. */
function view(workflowId: string, revision = 7) {
	return {
		workflowId,
		changeId: workflowId,
		repository: "/repo",
		status: "active",
		startedBy: "orchestrator",
		task: "add a feature",
		revision,
		currentStep: {
			id: "core.implementation",
			label: "Implementation",
			attempt: 1,
			enteredAt: "",
		},
		runs: [],
		effects: [],
		health: { valid: true, attention: [] },
		availableActions: [],
	};
}

const BOARD = [
	{
		target: "/repo",
		startedBy: "orchestrator",
		state: { workflowId: "wf-1", status: "active" },
		tasks: [0, 0],
		agents: [],
	},
	{
		target: "/other",
		startedBy: "orchestrator",
		state: { workflowId: "wf-2", status: "active" },
		tasks: [0, 0],
		agents: [],
	},
];

const VIEWS: Record<string, ReturnType<typeof view>> = {
	"wf-1": view("wf-1", 7),
	"wf-2": view("wf-2", 11),
};

async function withServer<T>(
	run: (
		tools: Map<string, Tool>,
		started: WorkflowStartRequest[],
		read: string[],
	) => Promise<T>,
	options: {
		lastDeveloperMessage?: string;
		changes?: unknown[];
		startError?: string;
		/** Extra identity rows: a second repository holding an id the base board
		 * already knows (`wf-1` in two repositories). */
		board?: Array<{ target: string; workflowId: string }>;
	} = {},
): Promise<T> {
	const started: WorkflowStartRequest[] = [];
	// Every view read as `repo/workflowId`: a test asserts which repository the
	// board resolved for an id it was not told.
	const read: string[] = [];
	const extra = (options.board ?? []).map((row) => ({
		target: row.target,
		startedBy: "orchestrator",
		state: { workflowId: row.workflowId, status: "active" },
		tasks: [0, 0] as [number, number],
		agents: [],
	}));
	const operations = {
		runObservation: async (request: unknown) => {
			const kind = (request as { kind?: string }).kind;
			if (kind === "workflows") return BOARD;
			// The board's identity rows: the read a resolution resolves against.
			if (kind === "workflow-targets")
				return [...BOARD, ...extra].map((row) => ({
					workflowId: row.state.workflowId,
					target: row.target,
				}));
			if (kind === "openspec-changes") {
				const rows = options.changes ?? [];
				const limit = (request as { limit?: number }).limit;
				return limit === undefined ? rows : rows.slice(0, limit);
			}
			return [];
		},
		// The board's own rows name the repository; a view for a repository the
		// board does not place the id in, or for an id it does not know at all, is
		// what the server refuses.
		view: (repo: string, workflowId: string) => {
			read.push(`${repo}/${workflowId}`);
			const found = VIEWS[workflowId];
			const owners = [...BOARD, ...extra]
				.filter((row) => row.state.workflowId === workflowId)
				.map((row) => row.target);
			if (!found || !owners.includes(repo))
				throw new Error(`workflow not found: ${workflowId}`);
			return found;
		},
		start: async (request: WorkflowStartRequest) => {
			started.push(request);
			if (options.startError) throw new Error(options.startError);
			return request.taskRef
				? `started ${request.workflowId} — task from change "${request.taskRef.change}", 640 task chars`
				: `started ${request.workflowId}`;
		},
	} as unknown as ServerOperations;
	const server = await startWorkflowServer({ operations });
	try {
		return await run(
			toolsFor(server.url, server.token, options),
			started,
			read,
		);
	} finally {
		await server.stop();
	}
}

describe("workflow id resolution", () => {
	test("one id or several, deduplicated and bounded at eight", () => {
		expect(decodeWorkflowIds("wf-1")).toEqual(["wf-1"]);
		expect(decodeWorkflowIds(["wf-1", "wf-2", "wf-1"])).toEqual([
			"wf-1",
			"wf-2",
		]);
		expect(decodeWorkflowIds(["  wf-1  "])).toEqual(["wf-1"]);
		expect(() => decodeWorkflowIds([])).toThrow(/at least one workflowId/);
		expect(() => decodeWorkflowIds(["   "])).toThrow(/at least one workflowId/);
		expect(() =>
			decodeWorkflowIds(Array.from({ length: 9 }, (_, i) => `wf-${i}`)),
		).toThrow(/at most 8/);
	});

	test("one revision applies to every id, a record names its own", () => {
		expect(decodeSinceRevisions(4, ["wf-1", "wf-2"])).toEqual(
			new Map([
				["wf-1", 4],
				["wf-2", 4],
			]),
		);
		expect(
			decodeSinceRevisions({ "wf-1": 4, "wf-9": 1 }, ["wf-1", "wf-2"]),
		).toEqual(new Map([["wf-1", 4]]));
		expect(decodeSinceRevisions(undefined, ["wf-1"])).toEqual(new Map());
	});

	test("the closest ids are ranked by token overlap, then by distance", () => {
		// The corpus's own mistake: a token-compatible name that does not exist,
		// next to the real change it was reaching for.
		const ranked = rankSimilarIds(
			[
				"add-environment-instance-lifecycle",
				"add-subscription-cleanup",
				"add-workflow-evidence-store",
			],
			"add-environment-instances",
		);
		expect(ranked.candidates[0]).toBe("add-environment-instance-lifecycle");
		// `add` is a shared token, so the other ids stay visible but rank below.
		expect(ranked.candidates).toContain("add-subscription-cleanup");
		expect(ranked.more).toBe(0);
		// A shared token is what makes an id a candidate at all, and none at all
		// means no candidate rather than an arbitrary one.
		expect(rankSimilarIds(["plain-name"], "other-name").candidates).toEqual([
			"plain-name",
		]);
		expect(rankSimilarIds(["plain-name"], "other-id").candidates).toEqual([]);
		expect(rankSimilarIds([], "wf-1")).toEqual({ candidates: [], more: 0 });
		// The list is bounded, and `more` says how many were left out.
		const many = Array.from(
			{ length: 9 },
			(_, index) => `add-flag-part-${index}`,
		);
		const bounded = rankSimilarIds(many, "add-flag-part");
		expect(bounded.candidates).toHaveLength(5);
		expect(bounded.more).toBe(4);
	});

	test("a multi-entry answer names its workflow, a lone entry does not", () => {
		const named = compactWorkflowStatus(view("wf-1"), {
			sinceRevision: 7,
			named: true,
		}) as Record<string, unknown>;
		expect(named).toEqual({
			workflowId: "wf-1",
			unchanged: true,
			revision: 7,
			status: "active",
			step: { id: "core.implementation", label: "Implementation" },
		});
		const lone = compactWorkflowStatus(view("wf-1"), {
			sinceRevision: 7,
		}) as Record<string, unknown>;
		expect(lone.workflowId).toBeUndefined();
		expect(lone.unchanged).toBe(true);
	});
});

describe("cheap wake-up tools", () => {
	test("list_changes answers the listing rows and honours a local limit", async () => {
		const rows = [
			{
				changeId: "add-flag",
				title: "Add the flag",
				tasks: "1/2",
				path: "openspec/changes/add-flag",
			},
			{ changeId: "other", path: "openspec/changes/other" },
		];
		await withServer(
			async (tools) => {
				const list = tools.get("list_changes");
				expect(list?.description).toContain("openspec/changes");
				// The listing is a prefix of a bounded set, and it says so: a change
				// that is absent may simply sort past the cut.
				expect(list?.description).toContain("first 100 active changes");
				if (!list) return;
				const all = await call(list, { repo: "/repo" });
				expect(json(all)).toEqual(rows);
				const limited = await call(list, { repo: "/repo", limit: 1 });
				expect(json(limited)).toEqual([rows[0]]);
			},
			{ changes: rows },
		);
	});

	test("workflow_status resolves the repository from the workflow board", async () => {
		await withServer(async (tools, _started, read) => {
			const status = tools.get("workflow_status");
			if (!status) throw new Error("missing workflow_status");
			const answer = (await call(status, {
				workflowId: "wf-2",
			})) as ToolResult;
			expect(answer.isError).toBeUndefined();
			// The board's row for `wf-2` names `/other`, so the view is read there
			// without the caller repeating the repository.
			expect((json(answer) as Record<string, unknown>).workflowId).toBe("wf-2");
			expect((json(answer) as Record<string, unknown>).target).toBe("/repo");
			expect(read).toEqual(["/other/wf-2"]);
		});
	});

	test("a named repository is where to look first, never a denial of a known id", async () => {
		await withServer(async (tools, _started, read) => {
			const status = tools.get("workflow_status");
			if (!status) throw new Error("missing workflow_status");
			const answer = (await call(status, {
				repo: "/other",
				workflowId: "wf-1",
			})) as ToolResult;
			// The board knows `wf-1` lives in `/repo`, so the answer is its row —
			// which names that target — instead of `unknown: true` plus candidates
			// that are all wrong.
			const row = json(answer) as Record<string, unknown>;
			expect(row.unknown).toBeUndefined();
			expect(row.workflowId).toBe("wf-1");
			expect(row.target).toBe("/repo");
			expect(read).toEqual(["/other/wf-1", "/repo/wf-1"]);
		});
	});

	test("a single id keeps its previous answer shape, unchanged or not", async () => {
		await withServer(async (tools) => {
			const status = tools.get("workflow_status");
			if (!status) throw new Error("missing workflow_status");
			const unchanged = (await call(status, {
				repo: "/repo",
				workflowId: "wf-1",
				sinceRevision: 7,
			})) as ToolResult;
			expect(json(unchanged)).toEqual({
				unchanged: true,
				revision: 7,
				status: "active",
				step: { id: "core.implementation", label: "Implementation" },
			});
			const changed = (await call(status, {
				repo: "/repo",
				workflowId: "wf-1",
				sinceRevision: 6,
			})) as ToolResult;
			expect((json(changed) as Record<string, unknown>).revision).toBe(7);
			expect(
				(json(changed) as Record<string, unknown>).unchanged,
			).toBeUndefined();
		});
	});

	test("several ids poll in one call, each with its own revision", async () => {
		await withServer(async (tools) => {
			const status = tools.get("workflow_status");
			if (!status) throw new Error("missing workflow_status");
			const answer = (await call(status, {
				workflowId: ["wf-1", "wf-2", "wf-gone"],
				sinceRevision: { "wf-1": 7, "wf-2": 10 },
			})) as ToolResult;
			expect(answer.isError).toBeUndefined();
			const entries = json(answer) as Array<Record<string, unknown>>;
			// One entry per requested id, in the requested order.
			expect(entries).toHaveLength(3);
			// The unchanged short-circuit names its workflow so the entries stay
			// distinguishable, and only `wf-1` is short-circuited.
			expect(entries[0]).toEqual({
				workflowId: "wf-1",
				unchanged: true,
				revision: 7,
				status: "active",
				step: { id: "core.implementation", label: "Implementation" },
			});
			expect(entries[1]?.workflowId).toBe("wf-2");
			expect(entries[1]?.revision).toBe(11);
			// No repository was named, so the candidates are the whole board's ids.
			expect(entries[2]).toEqual({
				workflowId: "wf-gone",
				unknown: true,
				candidates: ["wf-1", "wf-2"],
				more: 0,
			});
		});
	});

	test("one id in two repositories answers one named entry per target", async () => {
		await withServer(
			async (tools, _started, read) => {
				const status = tools.get("workflow_status");
				if (!status) throw new Error("missing workflow_status");
				const answer = (await call(status, {
					workflowId: "wf-1",
					sinceRevision: { "wf-1": 7 },
				})) as ToolResult;
				const entries = json(answer) as Array<Record<string, unknown>>;
				// Two entries mean two indistinguishable rows unless each one names
				// its workflow, so the short-circuit names it too.
				expect(entries).toHaveLength(2);
				expect(entries).toEqual([
					{
						workflowId: "wf-1",
						unchanged: true,
						revision: 7,
						status: "active",
						step: { id: "core.implementation", label: "Implementation" },
					},
					{
						workflowId: "wf-1",
						unchanged: true,
						revision: 7,
						status: "active",
						step: { id: "core.implementation", label: "Implementation" },
					},
				]);
				expect(read).toEqual(["/repo/wf-1", "/mirror/wf-1"]);
			},
			{ board: [{ target: "/mirror", workflowId: "wf-1" }] },
		);
	});

	test("an unknown id answers the closest ids instead of failing the call", async () => {
		await withServer(async (tools) => {
			const status = tools.get("workflow_status");
			if (!status) throw new Error("missing workflow_status");
			const answer = (await call(status, {
				repo: "/repo",
				workflowId: "wf-9",
			})) as ToolResult;
			// A failed poll costs a whole turn; the candidates let the model retry
			// with the right id in the same turn.
			expect(answer.isError).toBeUndefined();
			expect(json(answer)).toEqual({
				workflowId: "wf-9",
				unknown: true,
				candidates: ["wf-1"],
				more: 0,
			});
			// An empty candidate list still has a next step, and the description
			// names it: the tool that lists the ids that do exist.
			expect(status.description).toContain("call list_workflows");
		});
	});

	test("strict clients can start a stage test with nulls for all unused optional fields", async () => {
		await withServer(async (tools, started) => {
			const start = tools.get("start_workflow");
			if (!start) throw new Error("missing start_workflow");
			const unused = {
				blueprint: null,
				taskRef: null,
				app: null,
				ticket: null,
				sourceBranch: null,
				targetBranch: null,
			};
			for (const key of [
				...Object.keys(unused),
				"workflowType",
				"task",
				"mode",
				"preset",
				"stage",
			]) {
				expect(start.parameters.properties[key]?.anyOf).toContainEqual({
					type: "null",
				});
			}
			const input = {
				repo: "/repo",
				workflowId: "stage-run",
				workflowType: "stage-test",
				task: "Test the customer process using blocks",
				stage: "qa-ava",
				preset: "copilot-sol",
				mode: "worktree",
				...unused,
			};
			const result = await call(start, input);
			expect(result.isError).not.toBe(true);
			expect(started).toHaveLength(1);
			expect(started[0]).toMatchObject({
				repo: "/repo",
				workflowId: "stage-run",
				workflowType: "stage-test",
				task: input.task,
				stage: "qa-ava",
				preset: "copilot-sol",
				mode: "worktree",
			});
			for (const key of Object.keys(unused))
				expect(started[0]).not.toHaveProperty(key);
			expect(input).toHaveProperty("blueprint", null); // no mutation of caller data
		});
	});

	test("null selection is absent, but genuine conflicting workflow and task selections still fail", async () => {
		await withServer(async (tools, started) => {
			const start = tools.get("start_workflow");
			if (!start) throw new Error("missing start_workflow");
			const base = { repo: "/repo", workflowId: "wf-1", task: "test" };
			for (const selection of [
				{ workflowType: null, blueprint: null },
				{ workflowType: "solo", blueprint: { label: "not a placeholder" } },
				{
					workflowType: "solo",
					blueprint: null,
					taskRef: { change: "real-change" },
				},
			]) {
				expect((await call(start, { ...base, ...selection })).isError).toBe(
					true,
				);
			}
			expect(started).toHaveLength(0);
			const result = await call(start, {
				repo: "/repo",
				workflowId: "wf-1",
				workflowType: "solo",
				blueprint: null,
				task: null,
				taskRef: { change: "real-change" },
				mode: null,
				preset: null,
				app: null,
				stage: null,
				ticket: null,
				sourceBranch: null,
				targetBranch: null,
			});
			expect(result.isError).not.toBe(true);
			expect(started[0]).toMatchObject({
				taskRef: { change: "real-change" },
				mode: "worktree",
			});
			expect(started[0]).not.toHaveProperty("task");
		});
	});

	test("start_workflow refuses a task and a taskRef together, and neither", async () => {
		await withServer(async (tools, started) => {
			const start = tools.get("start_workflow");
			if (!start) throw new Error("missing start_workflow");
			const both = (await call(start, {
				repo: "/repo",
				workflowId: "wf-1",
				workflowType: "solo",
				task: "add a flag",
				taskRef: { change: "add-flag" },
			})) as ToolResult;
			expect(both.isError).toBe(true);
			expect(both.content[0]?.text).toContain("not both");
			// Preferring one silently would hide a reference that never resolved.
			expect(
				(await call(start, {
					repo: "/repo",
					workflowId: "wf-1",
					workflowType: "solo",
				})) as ToolResult,
			).toMatchObject({ isError: true });
			// One reference shape at a time: a reference that named both would leave
			// the caller guessing which one the task came from.
			const bothShapes = (await call(start, {
				repo: "/repo",
				workflowId: "wf-1",
				workflowType: "solo",
				taskRef: { change: "add-flag", previousMessage: true },
			})) as ToolResult;
			expect(bothShapes.isError).toBe(true);
			expect(bothShapes.content[0]?.text).toContain("not both");
			expect(started).toHaveLength(0);
		});
	});

	test("the wire contract refuses a task and a taskRef on its own", async () => {
		// The tool's guard throws before it POSTs, so the boundary's own refusal is
		// asserted on the start request schema: a caller that skips the tool still
		// cannot send both.
		const both = Schema.decodeUnknownEither(workflowStartRequestSchema)({
			repo: "/repo",
			workflowId: "wf-1",
			mode: "worktree",
			task: "add a flag",
			taskRef: { change: "add-flag" },
		});
		expect(both._tag).toBe("Left");
		expect(both._tag === "Left" ? String(both.left.message) : "").toContain(
			"cannot carry both",
		);
		const reference = Schema.decodeUnknownEither(workflowStartRequestSchema)({
			repo: "/repo",
			workflowId: "wf-1",
			mode: "worktree",
			taskRef: { change: "add-flag" },
		});
		expect(
			reference._tag === "Right" ? reference.right.task : "decoded",
		).toBeUndefined();
	});

	test("previousMessage sends the developer's own last message as the task", async () => {
		const message = "make the flag configurable per preset";
		await withServer(
			async (tools, started) => {
				const start = tools.get("start_workflow");
				if (!start) throw new Error("missing start_workflow");
				const answer = (await call(start, {
					repo: "/repo",
					workflowId: "wf-1",
					workflowType: "solo",
					taskRef: { previousMessage: true },
				})) as ToolResult;
				expect(answer.isError).toBeUndefined();
				// The host resolves the message (the server holds no conversation) and
				// the answer says where the task came from and how long it was.
				expect(started[0]?.task).toBe(message);
				expect(started[0]?.taskRef).toBeUndefined();
				expect(answer.content[0]?.text).toBe(
					`started wf-1 — task from the previous developer message, ${message.length} task chars`,
				);
			},
			{ lastDeveloperMessage: message },
		);
	});

	test("previousMessage over the task bound is refused, never cut", async () => {
		const long = "x".repeat(16_001);
		await withServer(
			async (tools, started) => {
				const start = tools.get("start_workflow");
				if (!start) throw new Error("missing start_workflow");
				const answer = (await call(start, {
					repo: "/repo",
					workflowId: "wf-1",
					workflowType: "solo",
					taskRef: { previousMessage: true },
				})) as ToolResult;
				expect(answer.isError).toBe(true);
				expect(answer.content[0]?.text).toContain("over the 16000-character");
				expect(started).toHaveLength(0);
			},
			{ lastDeveloperMessage: long },
		);
	});

	test("previousMessage without a developer message is refused", async () => {
		await withServer(async (tools, started) => {
			const start = tools.get("start_workflow");
			if (!start) throw new Error("missing start_workflow");
			const answer = (await call(start, {
				repo: "/repo",
				workflowId: "wf-1",
				workflowType: "solo",
				taskRef: { previousMessage: true },
			})) as ToolResult;
			expect(answer.isError).toBe(true);
			expect(answer.content[0]?.text).toContain("no developer message yet");
			expect(started).toHaveLength(0);
		});
	});

	test("a change reference travels as taskRef and the server echoes it", async () => {
		await withServer(async (tools, started) => {
			const start = tools.get("start_workflow");
			if (!start) throw new Error("missing start_workflow");
			const answer = (await call(start, {
				repo: "/repo",
				workflowId: "wf-1",
				workflowType: "solo",
				taskRef: { change: "add-flag" },
			})) as ToolResult;
			expect(answer.isError).toBeUndefined();
			// The wire carries the reference, not text: the server resolves it, so
			// the reference passes the same start guard as an inline task.
			expect(started[0]?.taskRef).toEqual({ change: "add-flag" });
			expect(started[0]?.task).toBeUndefined();
			expect(answer.content[0]?.text).toBe(
				'started wf-1 — task from change "add-flag", 640 task chars',
			);
		});
	});
	test("a start refusal is relayed verbatim and carries the server's code", async () => {
		// The refusal is the answer: the model has to see which paths are dirty to
		// act on them, so the message itself is neither rewrapped nor truncated. The
		// server's error code follows it as a separate bracketed token, which is what
		// `[stage-not-configured]` relies on too.
		const refusal =
			"working tree must be clean before workflow start: 23 dirty path(s): " +
			"dirty-00.txt, dirty-01.txt, dirty-02.txt, dirty-03.txt, " +
			"dirty-04.txt, dirty-05.txt, dirty-06.txt, dirty-07.txt, " +
			"dirty-08.txt, dirty-09.txt, dirty-10.txt, dirty-11.txt, " +
			"dirty-12.txt, dirty-13.txt, dirty-14.txt, dirty-15.txt, " +
			"dirty-16.txt, dirty-17.txt, dirty-18.txt, dirty-19.txt (+3 more)";
		await withServer(
			async (tools) => {
				const start = tools.get("start_workflow");
				if (!start) throw new Error("missing start_workflow");
				const answer = (await call(start, {
					repo: "/repo",
					workflowId: "wf-1",
					workflowType: "solo",
					task: "add a flag",
				})) as ToolResult;
				expect(answer.isError).toBe(true);
				expect(answer.content[0]?.text).toBe(`${refusal} [bad-request]`);
			},
			{ startError: refusal },
		);
	});
});
