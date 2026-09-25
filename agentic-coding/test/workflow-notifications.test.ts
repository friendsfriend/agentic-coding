// Developer-action notification projection, transition dedup, and trusted
// preference tests (workflow-developer-notifications, tasks 1.1-1.3).
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import {
	DEFAULT_CONFIG,
	herdrNotificationsEnabled,
} from "../src/workflow/effects.ts";
import {
	developerActionNotification,
	nextOwedState,
	workflowNotificationKey,
} from "../src/workflow/notifications.ts";
import { standaloneClassifications } from "../src/workflow/sidebar.ts";

function view(overrides: {
	workflowId?: string;
	status?: WorkflowView["status"];
	actions?: Array<{ id: string; requiresInput?: boolean }>;
	pendingRunIds?: string[];
	stepLabel?: string;
	repository?: string;
	worktree?: string;
	definitionId?: string;
}): WorkflowView {
	return {
		workflowId: overrides.workflowId ?? "wf",
		changeId: "wf",
		revision: 4,
		definition: {
			id: overrides.definitionId ?? "openspec-full",
			version: 1,
			digest: "d",
			label: "Full",
		},
		status: overrides.status ?? "active",
		repository: overrides.repository ?? "/projects/agentic-coding",
		worktree: overrides.worktree ?? "/projects/agentic-coding",
		branch: "feature/x",
		baseCommit: "abc",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		currentStep: {
			id: "core.implementation",
			label: overrides.stepLabel ?? "Implementation",
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
				paneId: "w1:p1",
			},
		],
		routing: { defaultProfile: "default", routes: [] },
		effects: [],
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

function tempHome(
	config: string | undefined,
	projectOverride?: string,
): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "notify-home-"));
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

describe("notification opt-in configuration (task 1.1)", () => {
	const rootFor = (home: string) =>
		path.join(home, ".config", "agentic-coding");
	const enabled = (home: string) =>
		herdrNotificationsEnabled(home, rootFor(home));

	test("defaults to disabled", () => {
		expect(DEFAULT_CONFIG.ui.herdr_notifications).toBe(false);
		expect(enabled(tempHome(undefined))).toBe(false);
		expect(enabled(tempHome('[ui]\ntheme = "dark"\n'))).toBe(false);
	});

	test("the trusted user preference is honored", () => {
		expect(enabled(tempHome("[ui]\nherdr_notifications = true\n"))).toBe(true);
		expect(enabled(tempHome("[ui]\nherdr_notifications = false\n"))).toBe(
			false,
		);
	});

	test("a project overlay or env-selected whole config cannot enable it", () => {
		const home = tempHome(
			"[ui]\nherdr_notifications = false\n",
			"[ui]\nherdr_notifications = true\n",
		);
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-env-"));
		const decoy = path.join(decoyDir, "config.json");
		fs.writeFileSync(
			decoy,
			JSON.stringify({ ui: { herdr_notifications: true } }),
		);
		process.env.HERDR_WORKFLOW_CONFIG = decoy;
		try {
			// The trusted user file wins and the env-selected whole config is not
			// consulted at all, so the server-wide choice stays disabled.
			expect(enabled(home)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
		}
	});

	test("existing user configuration stays untouched", () => {
		const home = tempHome('[workflow]\nremote = "upstream"\n');
		expect(enabled(home)).toBe(false);
		expect(
			fs.readFileSync(
				path.join(home, ".config", "agentic-coding", "config.toml"),
				"utf8",
			),
		).toBe('[workflow]\nremote = "upstream"\n');
	});

	test("the sidebar and notification preferences are independent", () => {
		const home = tempHome("[ui]\nherdr_sidebar = true\n");
		expect(enabled(home)).toBe(false);
	});
});

describe("developer-action projection (task 1.2)", () => {
	test("a paused workflow names the project, workflow, and phase", () => {
		const notification = developerActionNotification(
			view({ status: "paused" }),
			false,
		);
		expect(notification).toBeDefined();
		expect(notification?.workflowId).toBe("wf");
		expect(notification?.title).toBe("agentic-coding · wf");
		expect(notification?.body).toBe("Implementation");
	});

	test("attention-required state and requiresInput actions both notify", () => {
		expect(
			developerActionNotification(
				view({ status: "attention-required" }),
				false,
			),
		).toBeDefined();
		expect(
			developerActionNotification(
				view({ actions: [{ id: "approve-plan", requiresInput: true }] }),
				false,
			),
		).toBeDefined();
	});

	test("the live agent flag alone notifies regardless of committed questions", () => {
		// The projection is a pure flag consumer: `runRequiresDeveloperInput`
		// wiring lives in `viewAgentRequiresInput` and is covered by the observer
		// tests, so a `pendingRunIds` fixture here would be vacuous.
		expect(developerActionNotification(view({}), true)).toBeDefined();
	});

	test("an active workflow with no obligation does not notify", () => {
		expect(developerActionNotification(view({}), false)).toBeUndefined();
		expect(
			developerActionNotification(view({ actions: [{ id: "cancel" }] }), false),
		).toBeUndefined();
	});

	test("the phase label falls back to the step id", () => {
		const notification = developerActionNotification(
			view({ status: "paused", stepLabel: "" }),
			false,
		);
		expect(notification?.body).toBe("core.implementation");
	});

	test("a standalone workflow uses its target classification", () => {
		const research = view({
			definitionId: "research",
			repository: "",
			worktree: "/projects/wiki",
			status: "paused",
		});
		const notification = developerActionNotification(
			research,
			false,
			standaloneClassifications([research]),
		);
		expect(notification?.title).toBe("Research · wf");
	});

	test("terminal control sequences are stripped from the title and body", () => {
		const notification = developerActionNotification(
			view({
				status: "paused",
				repository: "/projects/evil\u001b]52;c;cGF3bmVk\u0007",
				stepLabel: "Step\u001b[2J",
			}),
			false,
		);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches the control characters the sanitizer must strip
		const control = /[\u0000-\u001f\u007f-\u009f]/;
		expect(notification?.title).not.toMatch(control);
		expect(notification?.body).not.toMatch(control);
	});

	test("the transition key is repository-scoped, not just the workflow id", () => {
		const repoA = view({ workflowId: "x", repository: "/a" });
		const repoB = view({ workflowId: "x", repository: "/b" });
		expect(workflowNotificationKey(repoA)).not.toBe(
			workflowNotificationKey(repoB),
		);
		expect(workflowNotificationKey(repoA)).toBe(
			workflowNotificationKey(
				view({
					workflowId: "x",
					repository: "/a",
				}),
			),
		);
	});
});

describe("transition dedup (task 1.3)", () => {
	test("the first observation records a baseline without notifying", () => {
		expect(nextOwedState(undefined, true)).toEqual({
			notify: false,
			state: true,
		});
		expect(nextOwedState(undefined, false)).toEqual({
			notify: false,
			state: false,
		});
	});

	test("only a false to true transition notifies", () => {
		expect(nextOwedState(false, true)).toEqual({ notify: true, state: true });
		expect(nextOwedState(true, true)).toEqual({ notify: false, state: true });
		expect(nextOwedState(false, false)).toEqual({
			notify: false,
			state: false,
		});
	});

	test("a clear re-arms the next obligation", () => {
		expect(nextOwedState(true, false)).toEqual({ notify: false, state: false });
		expect(nextOwedState(false, true)).toEqual({ notify: true, state: true });
	});
});
