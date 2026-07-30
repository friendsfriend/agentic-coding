import { expect, test } from "bun:test";
import { telemetryTest } from "../../agent-definitions/extensions/herdr-telemetry";

test("verifiers persist after settling", () => {
  expect(telemetryTest.isOneShot("quality-verifier")).toBe(false);
  expect(telemetryTest.isOneShot("archive")).toBe(true);
});

test("maps Pi token usage", () => {
  expect(telemetryTest.tokenUsage({ input: 12, output: 3, cacheRead: 40, cacheWrite: 5, totalTokens: 60 })).toEqual({
    inputTokens: 12,
    outputTokens: 3,
    cacheReadTokens: 40,
    cacheWriteTokens: 5,
    totalTokens: 60,
  });
});

test("compacts workers once when context crosses 250K tokens", () => {
  expect(telemetryTest.shouldCompact("worker", 250_000, 250_001, false)).toBe(true);
  expect(telemetryTest.shouldCompact("worker", 250_001, 260_000, false)).toBe(false);
  expect(telemetryTest.shouldCompact("worker", 250_000, 250_001, true)).toBe(false);
  expect(telemetryTest.shouldCompact("quality-verifier", 250_000, 250_001, false)).toBe(false);
});

test("resumes worker after proactive compaction", () => {
  const prompts: string[] = [];
  expect(telemetryTest.resumeAfterCompaction("worker", (prompt) => prompts.push(prompt))).toBe(true);
  expect(prompts).toEqual(["Continue current worker task from compacted context. Complete remaining implementation and required focused validation."]);
  expect(telemetryTest.resumeAfterCompaction("quality-verifier", (prompt) => prompts.push(prompt))).toBe(false);
  expect(prompts).toHaveLength(1);
});

test("recognizes successful worker verification handoff", () => {
  expect(telemetryTest.isWorkerVerifyCommand('cd /repo && herdr-workflow verify --repo "$PWD" --change change | tail -150')).toBe(true);
  expect(telemetryTest.isWorkerVerifyCommand("herdr-workflow status --repo . --change change")).toBe(false);
  expect(telemetryTest.verificationHandoffSucceeded(false, { content: "triage started: round 1 (full)" })).toBe(true);
  expect(telemetryTest.verificationHandoffSucceeded(false, { content: "verification already running: round 1" })).toBe(true);
  expect(telemetryTest.verificationHandoffSucceeded(false, { content: "verify invalid during phase triage" })).toBe(false);
  expect(telemetryTest.verificationHandoffSucceeded(true, { content: "triage started: round 1" })).toBe(false);
});

test("blocks only filesystem-global searches", () => {
  const cwd = "/workspace/repo";
  expect(telemetryTest.isGlobalSearch("find / -name '*.md'", cwd)).toBe(true);
  expect(telemetryTest.isGlobalSearch("find ~ -name '*.md'", cwd)).toBe(true);
  expect(telemetryTest.isGlobalSearch("locate herdr-workflow", cwd)).toBe(true);
  expect(telemetryTest.isGlobalSearch("mdfind herdr-workflow", cwd)).toBe(true);
  expect(telemetryTest.isGlobalSearch("find .. -name '*.ts'", cwd)).toBe(false);
  expect(telemetryTest.isGlobalSearch("find /other/project -name '*.ts'", cwd)).toBe(false);
  expect(telemetryTest.isGlobalSearch("mdfind -onlyin /other/project herdr", cwd)).toBe(false);
});

test("detects direct workflow state access", () => {
  const state = "/workspace/repo/.herdr-workflow/my-change/state.json";
  expect(telemetryTest.isWorkflowStateAccess("read", { path: state })).toBe(true);
  expect(telemetryTest.isWorkflowStateAccess("edit", { path: ".herdr-workflow/my-change/state.json" })).toBe(true);
  expect(telemetryTest.isWorkflowStateAccess("bash", { command: `python3 -c 'open("${state}")'` })).toBe(true);
  expect(telemetryTest.isWorkflowStateAccess("read", { path: "/workspace/repo/src/state.json" })).toBe(false);
  expect(telemetryTest.isWorkflowStateAccess("read", { path: ".herdr-workflow/my-change/reviews/input.json" })).toBe(false);
});

test("falls back once when verifier settles without result", () => {
  expect(telemetryTest.shouldRuntimeFallback("quality-verifier", false, false, "opencode/deepseek", "eon/sonnet")).toBe(true);
  expect(telemetryTest.shouldRuntimeFallback("quality-verifier", true, false, "opencode/deepseek", "eon/sonnet")).toBe(false);
  expect(telemetryTest.shouldRuntimeFallback("quality-verifier", false, true, "opencode/deepseek", "eon/sonnet")).toBe(false);
  expect(telemetryTest.shouldRuntimeFallback("worker", false, false, "opencode/deepseek", "eon/sonnet")).toBe(false);
  expect(telemetryTest.shouldRuntimeFallback("quality-verifier", false, false, "eon/sonnet", "eon/sonnet")).toBe(false);
});
