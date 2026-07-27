import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { debounce, watchDirectories } from "./watchRefresh";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("debounce collapses rapid triggers into one call", async () => {
  let calls = 0;
  const debounced = debounce(() => calls++, 20);

  debounced.trigger();
  debounced.trigger();
  debounced.trigger();
  await new Promise(resolve => setTimeout(resolve, 60));

  expect(calls).toBe(1);
  debounced.cancel();
});

test("debounce cancel suppresses a pending call", async () => {
  let calls = 0;
  const debounced = debounce(() => calls++, 20);

  debounced.trigger();
  debounced.cancel();
  await new Promise(resolve => setTimeout(resolve, 60));

  expect(calls).toBe(0);
});

test("watchDirectories fires onChange when a watched file changes, and skips missing dirs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-dash-watch-"));
  roots.push(dir);
  let calls = 0;
  const dispose = watchDirectories([dir, join(dir, "does-not-exist")], () => calls++, 20);

  writeFileSync(join(dir, "telemetry.jsonl"), '{"event":"start"}\n');
  await new Promise(resolve => setTimeout(resolve, 200));

  expect(calls).toBeGreaterThanOrEqual(1);
  dispose();
});
