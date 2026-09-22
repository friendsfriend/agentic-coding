import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { Assignment, ResolvedProfile } from "../src/contracts/workflow.ts";
import {
	HerdrLifecycle,
	OpenCodeAdapter,
	OpenCodeV2Adapter,
	PiAdapter,
} from "../src/workflow/adapters.ts";
import { renderAssignment } from "../src/workflow/assignment.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	parseAgentsConfig,
	profileFor,
	resolveRouting,
} from "../src/workflow/profiles.ts";
import { startRouting } from "../src/workflow/startup.ts";

class FakeHerdr {
	calls: string[][] = [];
	starts = 0;
	/** Leading launch prompts herdr accepts while the runtime still boots: the
	 * submission never reaches the agent, which therefore stays idle. */
	droppedPrompts = 0;
	private submissions = 0;
	private working = new Set<string>();
	prompts(): string[][] {
		return this.calls.filter(
			(call) => call[0] === "agent" && call[1] === "prompt",
		);
	}
	call(...args: string[]): unknown {
		this.calls.push(args);
		if (args[0] === "pane" && args[1] === "process-info")
			return {
				process_info: {
					shell_pid: 42,
					foreground_process_group_id: 42,
					foreground_processes: [{ name: "zsh", pid: 42 }],
				},
			};
		if (args[0] === "pane" && args[1] === "run") {
			const match = String(args[3] ?? "").match(/touch ([^;]+);/);
			if (match) fs.writeFileSync(match[1]?.replace(/^'|'$/g, ""), "");
			return {};
		}
		if (args[0] === "agent" && args[1] === "start") {
			this.starts++;
			if (this.starts === 1)
				throw new Error("target pane is not an available shell");
			return {
				agent: {
					pane_id: args[args.indexOf("--pane") + 1],
					tab_id: "tab",
					agent_status: "idle",
				},
			};
		}
		if (args[0] === "agent" && args[1] === "prompt") {
			this.submissions++;
			if (this.submissions > this.droppedPrompts)
				this.working.add(String(args[2]));
		}
		if (args[0] === "agent" && args[1] === "get")
			return {
				agent: {
					pane_id: args[2],
					tab_id: "tab",
					agent_status: this.working.has(String(args[2])) ? "working" : "idle",
				},
			};
		return {};
	}
}
const baseProfile = (runtime: ResolvedProfile["runtime"]): ResolvedProfile => ({
	name: runtime,
	runtime,
	executable: process.execPath,
	model: "provider/model",
	tools: ["read", "bash"],
	extensions: [],
	readOnly: true,
	capabilities: ["prompt", "run-environment", "observe", "read-only"],
	digest: runtime,
});
function assignment(
	stepId = "core.verification",
	overrides: Partial<Assignment> = {},
): Assignment {
	return {
		protocolVersion: 1,
		workflowId: "workflow",
		runId: "run",
		generation: 1,
		stepId,
		role: "quality-verifier",
		objective: "Review assigned files.",
		interaction: "silent",
		inputs: ["scope.md"],
		permissions: ["read"],
		checks: ["type check"],
		output: {
			path: "/tmp/output.json",
			schemaId: "core.findings",
			schemaVersion: 1,
			maxBytes: 1024,
		},
		allowedOutcomes: ["complete", "blocked", "failed"],
		environment: {
			HERDR_WORKFLOW_ID: "workflow",
			HERDR_CHANGE_ID: "change",
			HERDR_RUN_ID: "run",
			HERDR_RUN_GENERATION: "1",
			HERDR_RUN_TOKEN: "secret",
			HERDR_OUTPUT: "/tmp/output.json",
			HERDR_OUTPUT_SCHEMA_ID: "core.findings",
			HERDR_OUTPUT_SCHEMA_VERSION: "1",
			HERDR_STEP_ID: stepId,
			HERDR_ROLE: "quality-verifier",
			HERDR_PROFILE: "test",
			HERDR_RUNTIME: "pi",
			HERDR_TELEMETRY_PATH: "/tmp/telemetry.jsonl",
			TRACEPARENT: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
		},
		...overrides,
	};
}

describe("profiles, assignments, and adapters", () => {
	test("routing precedence and diversity are deterministic", () => {
		const registry = registerBuiltins();
		const definition = registry.definition("no-openspec", 1);
		const config = parseAgentsConfig({
			default_profile: "default",
			profiles: {
				default: { runtime: "pi" },
				step: { runtime: "opencode" },
				role: { runtime: "opencode-v2" },
			},
			routes: { "core.verification": "step" },
			role_routes: { "core.verification": { "quality-verifier": "role" } },
		});
		expect(
			profileFor("core.verification", "quality-verifier", definition, config)
				.name,
		).toBe("role");
		expect(
			profileFor("core.verification", "security-verifier", definition, config)
				.name,
		).toBe("step");
		const routing = resolveRouting(
			definition,
			{
				"core.implementation": ["worker"],
				"core.verification": ["quality-verifier"],
			},
			config,
		);
		expect(routing.routes).toHaveLength(2);
	});
	test("renderer pins assets, bounds prompt, and uses generic handoff only", () => {
		const step = registerBuiltins().step("core.verification");
		const rendered = renderAssignment(step, assignment());
		expect(rendered.prompt).toContain(
			"agentic-coding workflow handoff --outcome complete",
		);
		expect(rendered.prompt).not.toContain("/skill:");
		expect(rendered.prompt).not.toContain("HERDR_RUN_TOKEN");
		expect(rendered.prompt).not.toContain("herdr_");
		expect(rendered.prompt).toContain(`"runId": "run"`);
		expect(rendered.prompt).toContain("each item requires unique string `id`");
		const triageStep = registerBuiltins().step("core.triage");
		const triageAssignment = {
			...assignment("core.triage"),
			role: "triage",
			output: {
				path: "/tmp/triage.json",
				schemaId: "core.triage-plan",
				schemaVersion: 1,
				maxBytes: 1024,
			},
		};
		expect(renderAssignment(triageStep, triageAssignment).prompt).toContain(
			"non-empty string `reason`",
		);
		expect(() =>
			renderAssignment({ ...step, instructionDigests: ["bad"] }, assignment()),
		).toThrow(/pin mismatch/);
	});
	test("core.wiki assignment selects one role-specific approach file, never both", () => {
		const wikiStep = registerBuiltins().step("core.wiki");
		const wikiAssignment = assignment("core.wiki", { role: "wiki" });
		const wikiPrompt = renderAssignment(wikiStep, wikiAssignment).prompt;
		expect(wikiPrompt).toContain("Discovery-based drafting");
		expect(wikiPrompt).not.toContain("Directive-first drafting");
		expect(wikiPrompt).toContain("Project and shared knowledge scoping");
		const researchWikiAssignment = assignment("core.wiki", {
			role: "research-wiki",
		});
		const researchWikiPrompt = renderAssignment(
			wikiStep,
			researchWikiAssignment,
		).prompt;
		expect(researchWikiPrompt).toContain("Directive-first drafting");
		expect(researchWikiPrompt).not.toContain("Discovery-based drafting");
		expect(researchWikiPrompt).toContain(
			"Project and shared knowledge scoping",
		);
	});
	test("planning assignments preserve test-verifier ownership", () => {
		const step = registerBuiltins().step("core.plan");
		const prompt = renderAssignment(
			step,
			assignment("core.plan", { role: "planner" }),
		).prompt;
		expect(prompt).toContain("focused, change-relevant checks");
		expect(prompt).toContain("complete repository test suite");
		expect(prompt).toContain("workflow-owned `test-verifier`");
		expect(prompt).toContain("Do not require the worker");
	});
	test("all adapters use managed start/get/prompt and retry unavailable shell once", async () => {
		for (const [Adapter, runtime] of [
			[PiAdapter, "pi"],
			[OpenCodeAdapter, "opencode"],
			[OpenCodeV2Adapter, "opencode-v2"],
		] as const) {
			const fake = new FakeHerdr();
			const lifecycle = new HerdrLifecycle(fake, () => Effect.void);
			const adapter = new Adapter(lifecycle);
			const profile = baseProfile(runtime);
			const step = registerBuiltins().step("core.verification");
			const current = assignment();
			const rendered = renderAssignment(step, current);
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-"));
			try {
				const handle = await Effect.runPromise(
					adapter.launch({
						profile,
						assignment: current,
						rendered,
						paneId: "pane",
						cwd,
						name: `agent-${runtime}`,
						environment: current.environment,
						bridgePath: "/tmp/bridge.ts",
						workflowExtensionPath: "/tmp/developer-question.ts",
					}),
				);
				expect(handle.paneId).toBe("pane");
				expect(fake.starts).toBe(2);
				expect(
					fake.calls.some((call) => call[0] === "agent" && call[1] === "get"),
				).toBe(true);
				expect(
					fake.calls.some(
						(call) =>
							call[0] === "agent" &&
							call[1] === "prompt" &&
							call[3] === rendered.prompt,
					),
				).toBe(true);
				expect(
					fake.calls
						.flat()
						.some((arg) => arg === "--skill" || arg.startsWith("/skill:")),
				).toBe(false);
				const start = fake.calls.find(
					(call) => call[0] === "agent" && call[1] === "start",
				);
				if (!start) throw new Error("expected agent start call");
				expect(start).toContain("provider/model");
				expect(start.some((value) => value.startsWith("--env"))).toBe(false);
				if (runtime === "pi") {
					expect(start).toContain("/tmp/developer-question.ts");
					// Managed sessions never depend on pi's interactive project-trust
					// decision (a new worktree prompts on startup and eats the launch
					// prompt as its answer).
					expect(start).toContain("--no-approve");
					const toolsArg = start[start.indexOf("--tools") + 1];
					expect(toolsArg).toBeDefined();
					expect(toolsArg.split(",").sort()).toEqual(["bash", "read"]);
				} else expect(start).toContain("--auto");
				expect(
					fake.calls.some(
						(call) =>
							call[0] === "pane" &&
							call[1] === "run" &&
							call[2] === "pane" &&
							call[3].includes("set -a"),
					),
				).toBe(true);
				const envFile = path.join(
					cwd,
					".herdr-workflow",
					"runtime-bin",
					"run",
					"run.env",
				);
				expect(fs.readFileSync(envFile, "utf8")).toContain(
					"HERDR_WORKFLOW_ID=",
				);
				expect(fs.readFileSync(envFile, "utf8")).toContain("TRACEPARENT=");
				expect(
					fake.calls.some(
						(call) =>
							call[0] === "pane" &&
							call[1] === "process-info" &&
							call[2] === "--pane" &&
							call[3] === "pane",
					),
				).toBe(true);
				const launcher = fs.readFileSync(
					path.join(
						cwd,
						".herdr-workflow",
						"runtime-bin",
						"run",
						runtime === "pi" ? "pi" : "opencode",
					),
					"utf8",
				);
				expect(launcher).toContain(process.execPath);
				expect(launcher).toContain("export HERDR_WORKFLOW_ID=");
				expect(launcher).toContain("export PATH=");
				expect((await Effect.runPromise(adapter.observe(handle))).status).toBe(
					"working",
				);
				await Effect.runPromise(adapter.stop(handle));
				expect(
					fake.calls.some(
						(call) =>
							call[0] === "pane" && call[1] === "close" && call[2] === "pane",
					),
				).toBe(true);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		}
	});
	test("a launch prompt dropped while the runtime boots is re-submitted", async () => {
		const fake = new FakeHerdr();
		fake.droppedPrompts = 1;
		const adapter = new PiAdapter(new HerdrLifecycle(fake, () => Effect.void));
		const current = assignment();
		const rendered = renderAssignment(
			registerBuiltins().step("core.verification"),
			current,
		);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-boot-race-"));
		try {
			const handle = await Effect.runPromise(
				adapter.launch({
					profile: baseProfile("pi"),
					assignment: current,
					rendered,
					paneId: "pane",
					cwd,
					name: "agent-boot-race",
					environment: current.environment,
				}),
			);
			expect(handle.paneId).toBe("pane");
			expect(fake.prompts().map((call) => call[3])).toEqual([
				rendered.prompt,
				rendered.prompt,
			]);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
	test("a launch prompt that never reaches the agent fails the launch", async () => {
		const fake = new FakeHerdr();
		fake.droppedPrompts = 3;
		const adapter = new PiAdapter(new HerdrLifecycle(fake, () => Effect.void));
		const current = assignment();
		const rendered = renderAssignment(
			registerBuiltins().step("core.verification"),
			current,
		);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-lost-prompt-"));
		try {
			await expect(
				Effect.runPromise(
					adapter.launch({
						profile: baseProfile("pi"),
						assignment: current,
						rendered,
						paneId: "pane",
						cwd,
						name: "agent-lost-prompt",
						environment: current.environment,
					}),
				),
			).rejects.toThrow("agent did not start on its launch prompt");
			expect(fake.prompts()).toHaveLength(3);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
	test("research Pi launch keeps the profile's full tool access", async () => {
		const fake = new FakeHerdr();
		const adapter = new PiAdapter(new HerdrLifecycle(fake, () => Effect.void));
		const current = assignment("core.research", { role: "researcher" });
		const rendered = renderAssignment(
			registerBuiltins().step("core.research"),
			current,
		);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-research-"));
		try {
			await Effect.runPromise(
				adapter.launch({
					profile: {
						...baseProfile("pi"),
						tools: [],
						extensions: ["/tmp/research-extension.ts"],
						readOnly: false,
						capabilities: ["prompt", "shell", "edit"],
					},
					assignment: current,
					rendered,
					paneId: "pane",
					cwd,
					name: "agent-research",
					environment: current.environment,
				}),
			);
			const start = fake.calls.find(
				(call) => call[0] === "agent" && call[1] === "start",
			);
			if (!start) throw new Error("expected agent start call");
			expect(start).not.toContain("--tools");
			expect(start).not.toContain("--no-extensions");
			expect(start).toContain("/tmp/research-extension.ts");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
	test("research OpenCode launch keeps full permissions", async () => {
		for (const [Adapter, runtime] of [
			[OpenCodeAdapter, "opencode"],
			[OpenCodeV2Adapter, "opencode-v2"],
		] as const) {
			const fake = new FakeHerdr();
			const adapter = new Adapter(new HerdrLifecycle(fake, () => Effect.void));
			const current = assignment("core.research", { role: "researcher" });
			const rendered = renderAssignment(
				registerBuiltins().step("core.research"),
				current,
			);
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-research-"));
			try {
				await Effect.runPromise(
					adapter.launch({
						profile: {
							...baseProfile(runtime),
							tools: ["read", "web_search", "custom_tool"],
							readOnly: false,
							capabilities: ["prompt", "shell", "edit"],
						},
						assignment: current,
						rendered,
						paneId: "pane",
						cwd,
						name: `agent-${runtime}`,
						environment: current.environment,
					}),
				);
				const config = JSON.parse(
					fs.readFileSync(
						path.join(
							cwd,
							".herdr-workflow",
							"runtime-config",
							"run",
							"opencode.json",
						),
						"utf8",
					),
				) as { permission: Record<string, string> };
				expect(config.permission).toEqual({
					edit: "allow",
					bash: "allow",
					read: "allow",
				});
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		}
	});
	test("non-research OpenCode launch denies edits but keeps bash for read-only profiles", async () => {
		for (const [Adapter, runtime] of [
			[OpenCodeAdapter, "opencode"],
			[OpenCodeV2Adapter, "opencode-v2"],
		] as const) {
			const fake = new FakeHerdr();
			const adapter = new Adapter(new HerdrLifecycle(fake, () => Effect.void));
			const current = assignment("core.verification");
			const rendered = renderAssignment(
				registerBuiltins().step("core.verification"),
				current,
			);
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-verify-"));
			try {
				await Effect.runPromise(
					adapter.launch({
						profile: baseProfile(runtime),
						assignment: current,
						rendered,
						paneId: "pane",
						cwd,
						name: `agent-${runtime}`,
						environment: current.environment,
					}),
				);
				const config = JSON.parse(
					fs.readFileSync(
						path.join(
							cwd,
							".herdr-workflow",
							"runtime-config",
							"run",
							"opencode.json",
						),
						"utf8",
					),
				) as { permission: Record<string, string> };
				// Read-only denies edits only: focused checks and the handoff CLI
				// (`agentic-coding workflow handoff`) run through bash.
				expect(config.permission).toEqual({
					edit: "deny",
					bash: "allow",
					read: "allow",
				});
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		}
	});
	test("verification routes are pinned read-only with no edit/write tools", () => {
		const registry = registerBuiltins();
		const definition = registry.definition("openspec-full", 1);
		// Realistic user config: profiles carry no tools/capabilities, so they
		// resolve writable (shell + edit) and must be narrowed by the step policy.
		const agents = parseAgentsConfig({
			default_profile: "flash",
			profiles: { flash: { runtime: "pi", model: "provider/model" } },
		});
		const routing = startRouting(
			"openspec-full",
			undefined,
			definition,
			registry,
			agents,
		);
		const verifier = routing.routes.find(
			(route) => route.stepId === "core.verification",
		);
		if (!verifier) throw new Error("expected a verification route");
		expect(verifier.profile.readOnly).toBe(true);
		expect(verifier.profile.tools).toEqual([
			"read",
			"bash",
			"developer_question",
			"agent_ask",
		]);
		expect(verifier.profile.capabilities).toContain("read-only");
		expect(verifier.profile.capabilities).not.toContain("edit");
		expect(verifier.profile.capabilities).not.toContain("shell");
		const worker = routing.routes.find(
			(route) => route.stepId === "core.implementation",
		);
		expect(worker?.profile.readOnly).toBe(false);
	});
	test("verification Pi launch keeps bash and the question tools, no extensions", async () => {
		const registry = registerBuiltins();
		const definition = registry.definition("openspec-full", 1);
		const agents = parseAgentsConfig({
			default_profile: "flash",
			profiles: { flash: { runtime: "pi", model: "provider/model" } },
		});
		const routing = startRouting(
			"openspec-full",
			undefined,
			definition,
			registry,
			agents,
		);
		const profile = routing.routes.find(
			(route) => route.stepId === "core.verification",
		)?.profile;
		if (!profile) throw new Error("expected a verification route");
		const fake = new FakeHerdr();
		const adapter = new PiAdapter(new HerdrLifecycle(fake, () => Effect.void));
		const current = assignment("core.verification");
		const rendered = renderAssignment(
			registerBuiltins().step("core.verification"),
			current,
		);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-verify-pi-"));
		try {
			await Effect.runPromise(
				adapter.launch({
					profile,
					assignment: current,
					rendered,
					paneId: "pane",
					cwd,
					name: "agent-verify",
					environment: current.environment,
				}),
			);
			const start = fake.calls.find(
				(call) => call[0] === "agent" && call[1] === "start",
			);
			if (!start) throw new Error("expected agent start call");
			expect(start[start.indexOf("--tools") + 1]).toBe(
				"read,bash,developer_question,agent_ask",
			);
			expect(start).toContain("--no-extensions");
			expect(start).not.toContain("edit");
			expect(start).not.toContain("write");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
	test("preflight rejects missing executable and capabilities", () => {
		const adapter = new PiAdapter(
			new HerdrLifecycle(new FakeHerdr(), () => Effect.void),
		);
		expect(() =>
			adapter.preflight(
				{ ...baseProfile("pi"), executable: "/definitely/missing" },
				["prompt"],
			),
		).toThrow(/executable/);
		expect(() =>
			adapter.preflight({ ...baseProfile("pi"), capabilities: [] }, ["prompt"]),
		).toThrow(/required policy/);
		expect(() =>
			adapter.preflight({ ...baseProfile("pi"), tools: ["read"] }, [
				"prompt",
				"read-only",
			]),
		).not.toThrow();
		expect(registerBuiltins().step("core.verification").requirements).toContain(
			"read-only",
		);
	});
});
