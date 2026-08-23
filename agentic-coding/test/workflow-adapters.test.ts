import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	HerdrLifecycle,
	OpenCodeAdapter,
	OpenCodeV2Adapter,
	PiAdapter,
} from "../src/workflow/adapters.ts";
import { renderAssignment } from "../src/workflow/assignment.ts";
import type { Assignment, ResolvedProfile } from "../src/workflow/contracts.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	parseAgentsConfig,
	profileFor,
	resolveRouting,
} from "../src/workflow/profiles.ts";

class FakeHerdr {
	calls: string[][] = [];
	starts = 0;
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
		if (args[0] === "agent" && args[1] === "get")
			return {
				agent: { pane_id: args[2], tab_id: "tab", agent_status: "idle" },
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
function assignment(stepId = "core.verification"): Assignment {
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
	test("all adapters use managed start/get/prompt and retry unavailable shell once", async () => {
		for (const [Adapter, runtime] of [
			[PiAdapter, "pi"],
			[OpenCodeAdapter, "opencode"],
			[OpenCodeV2Adapter, "opencode-v2"],
		] as const) {
			const fake = new FakeHerdr();
			const lifecycle = new HerdrLifecycle(fake, async () => {});
			const adapter = new Adapter(lifecycle);
			const profile = baseProfile(runtime);
			const step = registerBuiltins().step("core.verification");
			const current = assignment();
			const rendered = renderAssignment(step, current);
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-"));
			try {
				const handle = await adapter.launch({
					profile,
					assignment: current,
					rendered,
					paneId: "pane",
					cwd,
					name: `agent-${runtime}`,
					environment: current.environment,
					bridgePath: "/tmp/bridge.ts",
				});
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
				expect((await adapter.observe(handle)).status).toBe("idle");
				await adapter.stop(handle);
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
	test("preflight rejects missing executable and capabilities", () => {
		const adapter = new PiAdapter(
			new HerdrLifecycle(new FakeHerdr(), async () => {}),
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
