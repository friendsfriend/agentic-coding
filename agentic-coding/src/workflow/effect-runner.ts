import fs from "node:fs";
import path from "node:path";
import {
	type AgentAdapter,
	HerdrLifecycle,
	type HerdrPort,
	type LaunchContext,
} from "./adapters.ts";
import { workflowAssets } from "./assets.ts";
import { renderAssignment } from "./assignment.ts";
import type { Assignment, EffectKind } from "./contracts.ts";
import { type CredentialPrompt, runGitWithCredentials } from "./credentials.ts";
import { childTrace, parseTraceparent, traceparent } from "./observability.ts";
import type { WorkflowRegistry } from "./registry.ts";
import {
	type ClaimedEffect,
	changedFilesIn,
	type WorkflowEngine,
} from "./runtime.ts";

export interface EffectHandler {
	observe?(effect: ClaimedEffect): Promise<unknown | undefined>;
	execute(effect: ClaimedEffect): Promise<unknown>;
}
export class EffectRunner {
	constructor(
		private readonly repo: string,
		private readonly engine: WorkflowEngine,
		private readonly handlers: Partial<Record<EffectKind, EffectHandler>>,
	) {}
	async drain(limit = 20): Promise<number> {
		let completed = 0;
		for (let batch = 0; batch < 20; batch++) {
			const effects = this.engine.claimEffects(this.repo, limit);
			if (!effects.length) break;
			for (const effect of effects) {
				const { lease } = effect;
				if (!lease) throw new Error(`claimed effect ${effect.id} has no lease`);
				const handler = this.handlers[effect.kind];
				if (!handler) {
					this.engine.dispatch(this.repo, {
						type: "effect.result",
						effectId: effect.id,
						lease,
						outcome: "failed",
						data: `no handler for ${effect.kind}`,
					});
					continue;
				}
				try {
					const observed = await handler.observe?.(effect);
					const data =
						observed === undefined || observed === false
							? await handler.execute(effect)
							: observed === true
								? { observed: true }
								: observed;
					this.engine.dispatch(this.repo, {
						type: "effect.result",
						effectId: effect.id,
						lease,
						outcome: "complete",
						data,
					});
					completed++;
				} catch (error) {
					this.engine.dispatch(this.repo, {
						type: "effect.result",
						effectId: effect.id,
						lease,
						outcome: effect.attempts < effect.maxAttempts ? "retry" : "failed",
						data: String((error as Error).message ?? error),
					});
				}
			}
		}
		return completed;
	}
}
export interface AdapterEffectOptions {
	registry: WorkflowRegistry;
	adapters: Map<string, AgentAdapter>;
	herdr: HerdrPort;
	remote?: string;
	prTool?: string;
	credentialPrompt?: CredentialPrompt;
	paneForRun(runId: string): Promise<{ paneId: string; tabId?: string }>;
}
export function agentEffectHandlers(
	repo: string,
	engine: WorkflowEngine,
	options: AdapterEffectOptions,
): Partial<Record<EffectKind, EffectHandler>> {
	const snapshotFor = (effect: ClaimedEffect) =>
		engine.getSnapshot(repo, effect.workflowId);
	const git = (cwd: string, ...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0)
			throw new Error(
				(result.stderr.toString() || result.stdout.toString()).trim(),
			);
		return result.stdout.toString().trim();
	};
	return {
		"workspace.setup": {
			async observe(effect) {
				const snapshot = snapshotFor(effect);
				const input = effect.payload as { mode?: string; branch?: string };
				const branch = input.branch ?? snapshot.metadata.branch;
				const worktree =
					snapshot.metadata.worktree ??
					(input.mode === "worktree"
						? worktreeForBranch(snapshot.metadata.repository, branch)
						: currentBranch(snapshot.metadata.repository) === branch
							? snapshot.metadata.repository
							: undefined);
				const workspace =
					snapshot.metadata.workspace ??
					recoverWorkspace(options.herdr, snapshot.metadata.changeId);
				return worktree && workspace && dashboardReady(options.herdr, workspace)
					? { workspace, worktree, branch }
					: undefined;
			},
			async execute(effect) {
				const snapshot = snapshotFor(effect);
				const input = effect.payload as {
					mode?: string;
					branch?: string;
					baseCommit?: string;
				};
				const branch = input.branch ?? snapshot.metadata.branch;
				let worktree =
					input.mode === "worktree"
						? worktreeForBranch(snapshot.metadata.repository, branch)
						: snapshot.metadata.repository;
				let workspace = recoverWorkspace(
					options.herdr,
					snapshot.metadata.changeId,
				);
				if (input.mode === "worktree" && !worktree) {
					const result = options.herdr.call(
						"worktree",
						"create",
						"--cwd",
						snapshot.metadata.repository,
						"--branch",
						branch,
						"--base",
						input.baseCommit ?? snapshot.metadata.baseCommit,
						"--label",
						snapshot.metadata.changeId,
						"--no-focus",
					) as {
						workspace?: { workspace_id?: string };
						worktree?: { path?: string };
					};
					workspace = result.workspace?.workspace_id;
					worktree = result.worktree?.path;
					if (!workspace || !worktree)
						throw new Error(
							"Herdr worktree setup returned incomplete identity",
						);
				} else {
					if (
						input.mode !== "worktree" &&
						currentBranch(snapshot.metadata.repository) !== branch
					) {
						const exists = git(
							snapshot.metadata.repository,
							"branch",
							"--list",
							branch,
						);
						git(
							snapshot.metadata.repository,
							"switch",
							...(exists
								? [branch]
								: [
										"-c",
										branch,
										input.baseCommit ?? snapshot.metadata.baseCommit,
									]),
						);
					}
					if (!worktree)
						throw new Error("workspace setup returned incomplete identity");
					if (!workspace) {
						const result = options.herdr.call(
							"workspace",
							"create",
							"--cwd",
							worktree,
							"--label",
							snapshot.metadata.changeId,
						) as { workspace?: { workspace_id?: string } };
						workspace = result.workspace?.workspace_id;
					}
				}
				if (!workspace || !worktree)
					throw new Error("workspace setup returned incomplete identity");
				await ensureWorkspaceTabs(
					options.herdr,
					workspace,
					worktree,
					snapshot.metadata.changeId,
				);
				return { workspace, worktree, branch };
			},
		},
		"artifact.write": {
			async observe(effect) {
				const expected = renderedAssignment(
					engine,
					repo,
					options.registry,
					runId(effect),
					"",
				);
				try {
					return fs.readFileSync(expected.run.assignmentPath, "utf8") ===
						`${expected.rendered.prompt}\n`
						? {
								path: expected.run.assignmentPath,
								digest: expected.rendered.digest,
							}
						: undefined;
				} catch {
					return undefined;
				}
			},
			async execute(effect) {
				const expected = renderedAssignment(
					engine,
					repo,
					options.registry,
					runId(effect),
					"",
				);
				fs.mkdirSync(path.dirname(expected.run.assignmentPath), {
					recursive: true,
				});
				const temporary = `${expected.run.assignmentPath}.${effect.id}.tmp`;
				fs.writeFileSync(temporary, `${expected.rendered.prompt}\n`, {
					mode: 0o600,
				});
				fs.renameSync(temporary, expected.run.assignmentPath);
				return {
					path: expected.run.assignmentPath,
					digest: expected.rendered.digest,
				};
			},
		},
		"agent.launch": {
			async observe(effect) {
				const run = engine.getRun(repo, runId(effect));
				const snapshot = engine.getSnapshot(repo, run.workflowId);
				if (run.handle) {
					try {
						const adapter = options.adapters.get(run.profile.runtime);
						return (await adapter?.observe(run.handle))?.status !== "unknown"
							? run.handle
							: undefined;
					} catch {
						return undefined;
					}
				}
				try {
					const result = options.herdr.call(
						"agent",
						"get",
						runName(snapshot.metadata.changeId, run),
					) as {
						agent?: {
							pane_id?: string;
							tab_id?: string;
							session_id?: string;
							agent_status?: string;
						};
					};
					const live = result.agent;
					if (!live?.pane_id || live.agent_status === "unknown")
						return undefined;
					const expected = renderedAssignment(
						engine,
						repo,
						options.registry,
						run.id,
						"",
					);
					options.herdr.call(
						"agent",
						"prompt",
						live.pane_id,
						expected.rendered.prompt,
					);
					return {
						runtime: run.profile.runtime,
						name: runName(snapshot.metadata.changeId, run),
						paneId: live.pane_id,
						...(live.tab_id ? { tabId: live.tab_id } : {}),
						...(live.session_id ? { sessionId: live.session_id } : {}),
					};
				} catch {
					return undefined;
				}
			},
			async execute(effect) {
				const run = engine.getRun(repo, runId(effect));
				const snapshot = engine.getSnapshot(repo, run.workflowId);
				const step = options.registry.step(run.stepId);
				const token =
					effect.runToken ?? engine.issueRunCapability(repo, run.id);
				const assignment = assignmentFor(run, snapshot, token);
				const assetRoot = workflowAssets(
					snapshot.metadata.worktree,
					snapshot.metadata.changeId,
				);
				const rendered = renderAssignment(
					step,
					assignment,
					`${assetRoot}/instructions`,
				);
				const adapter = options.adapters.get(run.profile.runtime);
				if (!adapter)
					throw new Error(`adapter unavailable: ${run.profile.runtime}`);
				adapter.preflight(run.profile, step.requirements);
				const pane = await options.paneForRun(run.id);
				const ctx: LaunchContext = {
					profile: run.profile,
					assignment,
					rendered,
					paneId: pane.paneId,
					...(pane.tabId ? { tabId: pane.tabId } : {}),
					cwd: snapshot.metadata.worktree,
					name: runName(snapshot.metadata.changeId, run),
					environment: assignment.environment,
					bridgePath:
						run.profile.runtime === "pi"
							? `${assetRoot}/bridges/pi-telemetry.ts`
							: `${assetRoot}/bridges/${run.profile.runtime === "opencode-v2" ? "opencode-v2" : "opencode"}-telemetry.js`,
				};
				try {
					return await adapter.launch(ctx);
				} catch (error) {
					try {
						options.herdr.call("pane", "close", pane.paneId);
					} catch {
						/* preserve original launch error */
					}
					throw error;
				}
			},
		},
		"agent.stop": {
			async observe(effect) {
				const run = engine.getRun(repo, runId(effect));
				if (!run.handle) return true;
				try {
					const status = (
						await options.adapters.get(run.profile.runtime)?.observe(run.handle)
					)?.status;
					return status === "done" || status === "unknown";
				} catch {
					return true;
				}
			},
			async execute(effect) {
				const run = engine.getRun(repo, runId(effect));
				if (run.handle)
					await options.adapters.get(run.profile.runtime)?.stop(run.handle);
				return { stopped: true };
			},
		},
		"notification.show": {
			async execute(effect) {
				const body = effect.payload as { title?: string; body?: string };
				options.herdr.call(
					"notification",
					"show",
					body.title ?? "Workflow update",
					"--body",
					body.body ?? "",
				);
				return { shown: true };
			},
		},
		"openspec.validate": {
			async execute(effect) {
				const snapshot = snapshotFor(effect);
				const result = Bun.spawnSync(
					["openspec", "validate", snapshot.metadata.changeId, "--strict"],
					{ cwd: snapshot.metadata.worktree, stdout: "pipe", stderr: "pipe" },
				);
				if (result.exitCode !== 0)
					throw new Error(
						(result.stderr.toString() || result.stdout.toString()).trim(),
					);
				return { validated: true };
			},
		},
		"delivery.commit": {
			async observe(effect) {
				const snapshot = snapshotFor(effect);
				return git(snapshot.metadata.worktree, "status", "--porcelain") === "";
			},
			async execute(effect) {
				const snapshot = snapshotFor(effect);
				git(snapshot.metadata.worktree, "add", "-A");
				if (git(snapshot.metadata.worktree, "diff", "--cached", "--name-only"))
					git(
						snapshot.metadata.worktree,
						"commit",
						"-m",
						`Apply ${snapshot.metadata.changeId}`,
					);
				return { head: git(snapshot.metadata.worktree, "rev-parse", "HEAD") };
			},
		},
		"delivery.push": {
			async observe(effect) {
				const snapshot = snapshotFor(effect);
				try {
					return (
						git(snapshot.metadata.worktree, "rev-parse", "@{upstream}") ===
						git(snapshot.metadata.worktree, "rev-parse", "HEAD")
					);
				} catch {
					return false;
				}
			},
			async execute(effect) {
				const snapshot = snapshotFor(effect);
				await runGitWithCredentials(
					snapshot.metadata.worktree,
					[
						"push",
						"--set-upstream",
						options.remote ?? "origin",
						snapshot.metadata.branch,
					],
					{ prompt: options.credentialPrompt },
				);
				return { head: git(snapshot.metadata.worktree, "rev-parse", "HEAD") };
			},
		},
		"pull-request.create": {
			async observe(effect) {
				const snapshot = snapshotFor(effect);
				const tool = options.prTool
					? Bun.which(options.prTool)
					: (Bun.which("gh") ?? Bun.which("glab"));
				if (!tool) return false;
				const args =
					tool.endsWith("/gh") || tool === "gh"
						? ["pr", "view", snapshot.metadata.branch, "--json", "url"]
						: ["mr", "view", snapshot.metadata.branch, "--output", "json"];
				return (
					Bun.spawnSync([tool, ...args], {
						cwd: snapshot.metadata.worktree,
						stdout: "pipe",
						stderr: "pipe",
					}).exitCode === 0
				);
			},
			async execute(effect) {
				const snapshot = snapshotFor(effect);
				const tool = options.prTool
					? Bun.which(options.prTool)
					: (Bun.which("gh") ?? Bun.which("glab"));
				if (!tool) throw new Error("no configured PR executable (gh or glab)");
				const args =
					tool.endsWith("/gh") || tool === "gh"
						? ["pr", "create", "--fill"]
						: ["mr", "create", "--fill"];
				const result = Bun.spawnSync([tool, ...args], {
					cwd: snapshot.metadata.worktree,
					stdout: "pipe",
					stderr: "pipe",
				});
				if (result.exitCode !== 0)
					throw new Error(
						(result.stderr.toString() || result.stdout.toString()).trim(),
					);
				return { url: result.stdout.toString().trim() };
			},
		},
		"workspace.close": {
			async observe(effect) {
				const workspace = snapshotFor(effect).metadata.workspace;
				if (!workspace) return true;
				try {
					const result = options.herdr.call("workspace", "get", workspace) as {
						workspace?: { status?: string; closed_at?: string };
					};
					return (
						result.workspace?.status === "closed" ||
						Boolean(result.workspace?.closed_at)
					);
				} catch (error) {
					return /not found|unknown workspace/i.test(
						String((error as Error).message),
					);
				}
			},
			async execute(effect) {
				const workspace = snapshotFor(effect).metadata.workspace;
				if (workspace) options.herdr.call("workspace", "close", workspace);
				return { closed: true };
			},
		},
		"workspace.cleanup": {
			async observe(effect) {
				const snapshot = snapshotFor(effect);
				return (
					snapshot.metadata.worktree === snapshot.metadata.repository ||
					!fs.existsSync(snapshot.metadata.worktree)
				);
			},
			async execute(effect) {
				const snapshot = snapshotFor(effect);
				if (snapshot.metadata.worktree !== snapshot.metadata.repository)
					git(
						snapshot.metadata.repository,
						"worktree",
						"remove",
						"--force",
						snapshot.metadata.worktree,
					);
				return { cleaned: true };
			},
		},
	};
}
function currentBranch(repo: string): string | undefined {
	const result = Bun.spawnSync(
		["git", "-C", repo, "branch", "--show-current"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	return result.exitCode === 0
		? result.stdout.toString().trim() || undefined
		: undefined;
}
function worktreeForBranch(repo: string, branch: string): string | undefined {
	const result = Bun.spawnSync(
		["git", "-C", repo, "worktree", "list", "--porcelain"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) return undefined;
	for (const block of result.stdout.toString().trim().split(/\n\n+/)) {
		const lines = block.split("\n");
		if (lines.includes(`branch refs/heads/${branch}`))
			return lines.find((line) => line.startsWith("worktree "))?.slice(9);
	}
	return undefined;
}
function recoverWorkspace(
	herdr: HerdrPort,
	identity: string,
): string | undefined {
	try {
		const result = herdr.call("workspace", "get", identity) as {
			workspace?: { workspace_id?: string; status?: string };
		};
		if (result.workspace?.status !== "closed" && result.workspace?.workspace_id)
			return result.workspace.workspace_id;
	} catch {
		/* fall through to list recovery */
	}
	try {
		const result = herdr.call("workspace", "list") as {
			workspaces?: Array<{
				workspace_id?: string;
				label?: string;
				name?: string;
				status?: string;
			}>;
		};
		return result.workspaces?.find(
			(item) =>
				item.status !== "closed" &&
				(item.label === identity || item.name === identity),
		)?.workspace_id;
	} catch {
		return undefined;
	}
}
function dashboardReady(herdr: HerdrPort, workspace: string): boolean {
	try {
		const result = herdr.call("tab", "list", "--workspace", workspace) as {
			tabs?: Array<{ label?: string }>;
		};
		return (result.tabs ?? []).some((tab) => tab.label === "dashboard");
	} catch {
		return false;
	}
}
async function ensureWorkspaceTabs(
	herdr: HerdrPort,
	workspace: string,
	worktree: string,
	changeId: string,
): Promise<void> {
	const tabs =
		(
			herdr.call("tab", "list", "--workspace", workspace) as {
				tabs?: Array<{ tab_id?: string; label?: string }>;
			}
		).tabs ?? [];
	if (!tabs.some((tab) => tab.label === "dashboard")) {
		const panes =
			(
				herdr.call("pane", "list", "--workspace", workspace) as {
					panes?: Array<{ pane_id?: string; tab_id?: string }>;
				}
			).panes ?? [];
		const tab = tabs[0];
		const root = tab?.tab_id
			? panes.find((pane) => pane.tab_id === tab.tab_id)?.pane_id
			: undefined;
		if (!tab?.tab_id || !root)
			throw new Error("workspace dashboard pane unavailable");
		await new HerdrLifecycle(herdr).waitForShell(root);
		herdr.call("tab", "rename", tab.tab_id, "dashboard");
		const command = [
			"agentic-coding",
			"dash",
			"--repo",
			worktree,
			"--change",
			changeId,
		]
			.map((value) => Bun.$.escape(value))
			.join(" ");
		herdr.call("pane", "run", root, command);
	}
	// Auxiliary git tab (lazygit): best-effort — the dashboard's Git panel
	// recreates it on demand if this fails (e.g. lazygit not installed).
	if (!tabs.some((tab) => tab.label === "git")) {
		try {
			const result = herdr.call(
				"tab",
				"create",
				"--workspace",
				workspace,
				"--cwd",
				worktree,
				"--label",
				"git",
			) as { root_pane?: { pane_id?: string } };
			const pane = result.root_pane?.pane_id;
			if (pane) herdr.call("pane", "run", pane, "lazygit");
		} catch {
			try {
				herdr.call(
					"tab",
					"close",
					tabs.find((tab) => tab.label === "git")?.tab_id ?? "",
				);
			} catch {}
		}
	}
}
function runName(
	changeId: string,
	run: ReturnType<WorkflowEngine["getRun"]>,
): string {
	// Herdr caps agent names at 32 chars (^[a-z][a-z0-9_-]*$). Grouped, one-shot
	// roles (triage/verification) anchor uniqueness on role + run id so each
	// round gets a fresh agent. Persistent single-role steps (planner, worker,
	// archive) must keep one stable identity across every run/generation of
	// that role within a workflow, so follow-up cycles (review comments,
	// blocked/failed retries) reuse the existing agent via `herdr agent prompt`
	// instead of always launching a new one.
	const suffix = ["core.triage", "core.verification"].includes(run.stepId)
		? `-${run.role}-${run.id.slice(0, 8)}`
		: `-${run.role}`;
	const head = changeId.slice(0, Math.max(1, 32 - suffix.length));
	return `${head}${suffix}`.slice(0, 32);
}
export const effectRunnerTest = { runName };
function renderedAssignment(
	engine: WorkflowEngine,
	repo: string,
	registry: WorkflowRegistry,
	runId: string,
	token: string,
) {
	const run = engine.getRun(repo, runId);
	const snapshot = engine.getSnapshot(repo, run.workflowId);
	const step = registry.step(run.stepId);
	const assignment = assignmentFor(run, snapshot, token);
	return {
		run,
		assignment,
		rendered: renderAssignment(
			step,
			assignment,
			`${workflowAssets(snapshot.metadata.worktree, snapshot.metadata.changeId)}/instructions`,
		),
	};
}
function runId(effect: ClaimedEffect): string {
	const id = String((effect.payload as { runId?: string }).runId ?? "");
	if (!id) throw new Error(`effect ${effect.id} missing runId`);
	return id;
}
function assignmentFor(
	run: ReturnType<WorkflowEngine["getRun"]>,
	snapshot: ReturnType<WorkflowEngine["getSnapshot"]>,
	token: string,
): Assignment {
	const output =
		run.outputPath && run.outputSchema
			? {
					path: run.outputPath,
					schemaId: run.outputSchema.id,
					schemaVersion: run.outputSchema.version,
					maxBytes: 512 * 1024,
				}
			: undefined;
	const context =
		snapshot.step.context &&
		typeof snapshot.step.context === "object" &&
		!Array.isArray(snapshot.step.context) &&
		"assignments" in snapshot.step.context
			? ((
					snapshot.step.context as { assignments?: Array<{ role: string }> }
				).assignments?.find((item) => item.role === run.role) ??
				snapshot.step.context)
			: snapshot.step.context;
	const changed = run.stepId === "core.triage" ? changedFilesIn(snapshot) : [];
	const inputs = [
		...(snapshot.metadata.task ? [`Task: ${snapshot.metadata.task}`] : []),
		...(changed.length ? [`Changed files: ${changed.join(" ")}`] : []),
		...(context === undefined
			? []
			: [`Step input: ${JSON.stringify(context)}`]),
		...snapshot.evidence
			.slice(-8)
			.map((item) => `${item.kind}: ${item.path} (${item.digest})`),
	];
	return {
		protocolVersion: 1,
		workflowId: run.workflowId,
		runId: run.id,
		generation: run.generation,
		stepId: run.stepId,
		role: run.role,
		objective: `Complete ${run.stepId} for ${snapshot.metadata.changeId}${snapshot.step.mode ? ` in ${snapshot.step.mode} mode` : ""}.`,
		interaction: ["planner", "worker"].includes(run.role)
			? "developer-dialogue"
			: "silent",
		inputs,
		permissions: run.profile.readOnly
			? ["read repository"]
			: ["read and edit repository"],
		checks:
			run.role === "worker" ? ["focused tests only"] : ["assigned checks"],
		...(output ? { output } : {}),
		allowedOutcomes: ["complete", "blocked", "failed"],
		environment: {
			HERDR_WORKFLOW_ID: run.workflowId,
			HERDR_CHANGE_ID: snapshot.metadata.changeId,
			HERDR_RUN_ID: run.id,
			HERDR_RUN_GENERATION: String(run.generation),
			HERDR_RUN_TOKEN: token,
			HERDR_OUTPUT: run.outputPath ?? "",
			HERDR_OUTPUT_SCHEMA_ID: run.outputSchema?.id ?? "",
			HERDR_OUTPUT_SCHEMA_VERSION: String(run.outputSchema?.version ?? ""),
			HERDR_STEP_ID: run.stepId,
			HERDR_ROLE: run.role,
			HERDR_PROFILE: run.profile.name,
			HERDR_RUNTIME: run.profile.runtime,
			HERDR_TELEMETRY_PATH: `${snapshot.metadata.worktree}/.herdr-workflow/${snapshot.metadata.changeId}/telemetry.jsonl`,
			TRACEPARENT: traceparent(
				childTrace(parseTraceparent(process.env.TRACEPARENT)),
			),
		},
	};
}
