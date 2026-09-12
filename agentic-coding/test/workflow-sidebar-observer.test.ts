// Sidebar presentation lifecycle tests (improve-herdr-workflow-sidebar, tasks
// 4.1 and 4.6): trusted user-only opt-in, question publication before a long
// wait, runtime-only changes updating markers, no-tab approval cards, refresh
// races rejecting obsolete results, and presentation failures leaving
// revisions/capabilities/effect attempts/execution results unchanged.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HerdrPort } from "../src/workflow/adapters.ts";
import type { WorkflowView } from "../src/workflow/contracts.ts";
import {
	DEFAULT_CONFIG,
	herdrSidebarEnabled,
} from "../src/workflow/effects.ts";
import { reconcileWorkflowSidebar } from "../src/workflow/operations.ts";
import { projectSidebar } from "../src/workflow/sidebar.ts";
import {
	reconcileSidebarOnce,
	SIDEBAR_FALLBACK_REFRESH_MS,
	SidebarPresentation,
} from "../src/workflow/sidebar-observer.ts";
import {
	BoundedSidebarDiagnostics,
	publishSidebar,
} from "../src/workflow/sidebar-sync.ts";

function view(overrides: {
	workflowId?: string;
	workspace?: string;
	paneId?: string;
	actions?: Array<{ id: string; requiresInput?: boolean }>;
	pendingRunIds?: string[];
	status?: WorkflowView["status"];
}): WorkflowView {
	const paneId = overrides.paneId ?? "w1:p1";
	return {
		workflowId: overrides.workflowId ?? "wf",
		changeId: "wf",
		revision: 4,
		definition: { id: "openspec-full", version: 1, digest: "d", label: "Full" },
		status: overrides.status ?? "active",
		repository: "/projects/agentic-coding",
		worktree: "/projects/agentic-coding",
		branch: "feature/x",
		baseCommit: "abc",
		...(overrides.workspace ? { workspace: overrides.workspace } : {}),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		currentStep: {
			id: "core.implementation",
			label: "Implementation",
			attempt: 1,
			enteredAt: "2026-01-01T00:00:00.000Z",
		},
		runs: [
			{
				id: "run-1",
				stepId: "core.implementation",
				role: "worker",
				attempt: 1,
				status: "working",
				runtime: "pi",
				profile: "default",
				paneId,
			},
		],
		routing: { defaultProfile: "default", routes: [] },
		effects: [
			{ id: "e1", kind: "agent.launch", status: "pending", attempts: 1 },
		],
		observations: [],
		health: { valid: true, attention: [] },
		pendingQuestions: (overrides.pendingRunIds ?? []).map((runId, index) => ({
			id: `q${index}`,
			workflowId: overrides.workflowId ?? "wf",
			runId,
			stepId: "core.implementation",
			role: "worker",
			description: "?",
			options: [],
			status: "pending" as const,
			createdAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2099-01-01T00:00:00.000Z",
		})),
		availableActions: (overrides.actions ?? []).map((action) => ({
			id: action.id,
			label: action.id,
			confirmation: "confirm" as const,
			...(action.requiresInput ? { requiresInput: true } : {}),
		})),
	};
}

interface RecordedCall {
	args: string[];
}

function fakeHerdr(options: {
	agentStatus?: string;
	agentStatusReads?: string[];
}): { herdr: HerdrPort; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let reads = 0;
	const herdr: HerdrPort = {
		call(...args: string[]) {
			calls.push({ args });
			if (args[0] === "agent" && args[1] === "list") {
				const scripted = options.agentStatusReads?.[reads++];
				return {
					agents: [
						{
							pane_id: "w1:p1",
							agent: "pi",
							agent_status: scripted ?? options.agentStatus ?? "idle",
						},
					],
				};
			}
			if (args[0] === "pane" && args[1] === "list")
				return {
					panes: [
						{
							pane_id: "w1:p1",
							workspace_id: "w1",
							agent_status: "idle",
						},
					],
				};
			if (args[0] === "workspace" && args[1] === "list")
				return {
					workspaces: [{ workspace_id: "w1", label: "agentic-coding" }],
				};
			return {};
		},
	};
	return { herdr, calls };
}

function metadataCalls(calls: RecordedCall[]): string[] {
	return calls
		.filter((call) => call.args[1] === "report-metadata")
		.map((call) => call.args.join(" "));
}

function tempHome(
	config: string | undefined,
	projectOverride?: string,
): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-home-"));
	if (config !== undefined) {
		const dir = path.join(home, ".config", "agentic-coding");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "config.toml"), config);
	}
	if (projectOverride !== undefined) {
		const repo = path.join(home, "repo", ".pi");
		fs.mkdirSync(repo, { recursive: true });
		fs.writeFileSync(path.join(repo, "herdr-workflow.toml"), projectOverride);
	}
	return home;
}

describe("sidebar opt-in configuration (task 4.1)", () => {
	test("defaults to disabled", () => {
		expect(DEFAULT_CONFIG.ui.herdr_sidebar).toBe(false);
		expect(herdrSidebarEnabled(tempHome(undefined))).toBe(false);
		expect(herdrSidebarEnabled(tempHome('[ui]\ntheme = "dark"\n'))).toBe(false);
	});

	test("the trusted user preference enables it", () => {
		expect(herdrSidebarEnabled(tempHome("[ui]\nherdr_sidebar = true\n"))).toBe(
			true,
		);
		expect(herdrSidebarEnabled(tempHome("[ui]\nherdr_sidebar = false\n"))).toBe(
			false,
		);
	});

	test("a project overlay cannot change the server-wide choice", () => {
		const home = tempHome("[ui]\nherdr_sidebar = false\n");
		const project = path.join(home, "repo", ".pi");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(
			path.join(project, "herdr-workflow.toml"),
			"[ui]\nherdr_sidebar = true\n",
		);
		expect(herdrSidebarEnabled(home)).toBe(false);
		// The env-selected whole-config replacement is equally out of scope.
		expect(process.env.HERDR_WORKFLOW_CONFIG).toBeUndefined();
	});

	test("existing user configuration stays untouched", () => {
		const home = tempHome('[workflow]\nremote = "upstream"\n');
		expect(herdrSidebarEnabled(home)).toBe(false);
		expect(
			fs.readFileSync(
				path.join(home, ".config", "agentic-coding", "config.toml"),
				"utf8",
			),
		).toBe('[workflow]\nremote = "upstream"\n');
	});
});

describe("sidebar presentation lifecycle (task 4.6)", () => {
	test("publishes the pending question before a long wait, then reconciles runtime changes", async () => {
		const { herdr, calls } = fakeHerdr({
			agentStatusReads: ["idle", "blocked"],
		});
		const views = [view({ workspace: "w1", pendingRunIds: ["run-1"] })];
		const presentation = new SidebarPresentation({
			herdr,
			views: () => views,
			refreshMs: 5,
		});
		await presentation.reconcile();
		const first = metadataCalls(calls);
		expect(
			first.some((call) => call.includes("ac_project_line=◆ agentic-coding")),
		).toBe(true);
		const callsAfterQuestion = calls.length;
		// Runtime-only change: no workflow revision changed, but the live read
		// reported a blocked approval prompt.
		await presentation.reconcile();
		const afterRuntime = metadataCalls(calls.slice(callsAfterQuestion));
		expect(
			afterRuntime.some((call) => call.includes("ac_status_line=└─ ◆ blocked")),
		).toBe(true);
		presentation.dispose();
	});

	test("a no-tab approval gate still updates its space card", async () => {
		const { herdr, calls } = fakeHerdr({});
		const gate = view({
			workspace: "w1",
			actions: [{ id: "approve-plan", requiresInput: true }],
		});
		await reconcileSidebarOnce({
			herdr,
			views: () => [{ ...gate, runs: [] }],
		});
		expect(metadataCalls(calls)).toContain(
			"workspace report-metadata w1 --source agentic-coding --token ac_project_line=◆ agentic-coding --token ac_workflow_line=├─ wf --token ac_type_line=│  openspec-full --token ac_phase_line=└─ Implementation",
		);
		// The agent card of the same space reflects only its own live state.
		expect(metadataCalls(calls)).toContain(
			"pane report-metadata w1:p1 --source agentic-coding --token ac_project_line=w1:p1 --token ac_status_line=└─ idle",
		);
	});

	test("the shared commit hook follows the trusted preference only", async () => {
		// Disabled: nothing is published, not even a read of Herdr.
		const off = fakeHerdr({});
		await reconcileWorkflowSidebar(
			off.herdr,
			{ list: () => [view({ workspace: "w1" })] } as never,
			"/repo",
			undefined,
			false,
		);
		expect(off.calls).toEqual([]);
		// Enabled: the committed mutation publishes the current cards.
		const on = fakeHerdr({});
		await reconcileWorkflowSidebar(
			on.herdr,
			{ list: () => [view({ workspace: "w1" })] } as never,
			"/repo",
			undefined,
			true,
		);
		expect(
			metadataCalls(on.calls).some((call) =>
				call.includes("--token ac_project_line="),
			),
		).toBe(true);
	});

	test("coalesces overlapping refreshes and skips unchanged publications", async () => {
		const { herdr, calls } = fakeHerdr({});
		const presentation = new SidebarPresentation({
			herdr,
			views: () => [view({ workspace: "w1" })],
		});
		await Promise.all([
			presentation.reconcile(),
			presentation.reconcile(),
			presentation.reconcile(),
		]);
		const first = metadataCalls(calls).length;
		expect(first).toBeGreaterThan(0);
		await presentation.reconcile();
		expect(metadataCalls(calls).length).toBe(first);
		presentation.dispose();
	});

	test("a refresh after pane reassignment clears the obsolete association", async () => {
		const { herdr, calls } = fakeHerdr({});
		let views = [view({ workspace: "w1", paneId: "w1:p1" })];
		const presentation = new SidebarPresentation({
			herdr,
			views: () => views,
		});
		await presentation.reconcile();
		expect(metadataCalls(calls).some((call) => call.includes("w1:p1"))).toBe(
			true,
		);
		views = [view({ workspace: "w1", paneId: "w1:p2" })];
		await presentation.reconcile();
		const cleared = metadataCalls(calls).filter((call) =>
			call.includes("--clear-token"),
		);
		expect(cleared.some((call) => call.includes("w1:p1"))).toBe(true);
		presentation.dispose();
	});

	test("publication failure never throws and leaves committed facts alone", async () => {
		const messages: string[] = [];
		const failing: HerdrPort = {
			call() {
				throw new Error("herdr unavailable");
			},
		};
		const target = view({ workspace: "w1" });
		const before = JSON.stringify(target);
		const presentation = new SidebarPresentation({
			herdr: failing,
			views: () => [target],
			diagnostics: new BoundedSidebarDiagnostics((message) =>
				messages.push(message),
			),
		});
		await expect(presentation.reconcile()).resolves.toBeUndefined();
		expect(messages).toEqual(["sidebar presentation: herdr unavailable"]);
		expect(JSON.stringify(target)).toBe(before);
		expect(target.revision).toBe(4);
		expect(target.effects[0]?.attempts).toBe(1);
		expect(target.effects[0]?.status).toBe("pending");
		presentation.dispose();
	});

	test("a vanished pane is skipped and never blocks the remaining cards", async () => {
		const calls: string[][] = [];
		const herdr: HerdrPort = {
			call(...args: string[]) {
				calls.push(args);
				if (args[1] === "report-metadata" && args[2] === "w1:p1")
					throw new Error(
						'herdr pane report-metadata: {"error":{"code":"pane_not_found"}}',
					);
				return {};
			},
		};
		const publication = {
			panes: [
				{ paneId: "w1:p1", tokens: { ac_input_rank: "0" } },
				{ paneId: "w1:p2", tokens: { ac_input_rank: "0" } },
			],
			workspaces: [{ workspaceId: "w1", tokens: { ac_project_line: "◇ p" } }],
			clearedPanes: [{ targetId: "w0:p9", tokens: ["ac_input_rank"] }],
			clearedWorkspaces: [],
		};
		const messages: string[] = [];
		await publishSidebar(herdr, publication, undefined, {
			report: (message) => messages.push(message),
		});
		expect(calls.some((args) => args[2] === "w1:p2" || args[2] === "w1")).toBe(
			true,
		);
		expect(calls.some((args) => args[2] === "w0:p9")).toBe(true);
		// A vanished target is not a failure worth reporting.
		expect(messages).toEqual([]);
	});

	test("a projection skips managed runs whose pane is gone", () => {
		const publication = projectSidebar({
			views: [view({ workspace: "w1" })],
			observations: [],
			unmanagedPanes: [
				{
					paneId: "wG:p1",
					workspaceId: "wG",
					label: "dash",
					status: "unknown",
				},
			],
			unmanagedWorkspaces: [{ workspaceId: "wG", label: "agentic-coding" }],
			livePaneIds: ["wG:p1"],
			liveWorkspaceIds: ["wG"],
			managedPaneIds: ["w1:p1"],
			managedWorkspaceIds: ["w1"],
		});
		expect(publication.panes.map((card) => card.paneId)).toEqual(["wG:p1"]);
		// Nothing to publish or clear on a target that no longer exists.
		expect(publication.workspaces).toEqual([
			{ workspaceId: "wG", tokens: { ac_project_line: "agentic-coding" } },
		]);
		expect(publication.clearedPanes).toEqual([]);
		expect(publication.clearedWorkspaces).toEqual([]);
	});

	test("the fallback interval is bounded and disposal stops it", async () => {
		expect(SIDEBAR_FALLBACK_REFRESH_MS).toBe(2000);
		const { herdr, calls } = fakeHerdr({});
		const presentation = new SidebarPresentation({
			herdr,
			views: () => [view({ workspace: "w1" })],
			refreshMs: 5,
		});
		presentation.start();
		await Bun.sleep(25);
		const callsBeforeDispose = calls.length;
		presentation.dispose();
		await Bun.sleep(25);
		expect(callsBeforeDispose).toBeGreaterThan(0);
		expect(calls.length).toBe(callsBeforeDispose);
	});

	test("disposal leaves the server-wide view for other live applications", async () => {
		const { herdr, calls } = fakeHerdr({});
		const presentation = new SidebarPresentation({
			herdr,
			views: () => [view({ workspace: "w1" })],
		});
		presentation.dispose();
		await expect(presentation.reconcile()).resolves.toBeUndefined();
		expect(calls).toEqual([]);
	});
});
