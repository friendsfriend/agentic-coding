import { describe, expect, test } from "bun:test";
import {
	runForeground,
	spawnAndWait,
	withForegroundTerminal,
} from "../../packages/devenv/cli/src/tui/actions/foreground.ts";

function fakeRenderer() {
	const calls: string[] = [];
	return {
		calls,
		suspend() {
			calls.push("suspend");
		},
		resume() {
			calls.push("resume");
		},
	};
}

describe("asynchronous foreground utilities (compose-unified-feature-shell task 4.3)", () => {
	test("suspends once and always resumes around a successful tool", async () => {
		const renderer = fakeRenderer();
		const code = await runForeground("true", [], { renderer });
		expect(code).toBe(0);
		expect(renderer.calls).toEqual(["suspend", "resume"]);
	});

	test("restores the renderer when the tool exits non-zero", async () => {
		const renderer = fakeRenderer();
		const code = await runForeground("false", [], { renderer });
		expect(code).not.toBe(0);
		expect(renderer.calls).toEqual(["suspend", "resume"]);
	});

	test("restores the renderer when the tool cannot be spawned", async () => {
		const renderer = fakeRenderer();
		const code = await runForeground("herdr-nonexistent-utility-for-test", [], {
			renderer,
		});
		expect(code).toBeUndefined();
		expect(renderer.calls).toEqual(["suspend", "resume"]);
	});

	test("serializes concurrent foreground owners so suspend/resume never interleave", async () => {
		const renderer = fakeRenderer();
		await Promise.all([
			runForeground("sh", ["-c", "sleep 0.05"], { renderer }),
			runForeground("sh", ["-c", "sleep 0.05"], { renderer }),
		]);
		// One owner suspends and resumes before the next one starts.
		expect(renderer.calls).toEqual(["suspend", "resume", "suspend", "resume"]);
	});

	test("a rejected owner resumes and does not wedge the foreground queue", async () => {
		const renderer = fakeRenderer();
		await expect(
			withForegroundTerminal(renderer, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await runForeground("true", [], { renderer });
		expect(renderer.calls).toEqual(["suspend", "resume", "suspend", "resume"]);
	});

	test("a nested shared-renderer owner reuses the active suspension", async () => {
		const renderer = fakeRenderer();
		await withForegroundTerminal(renderer, async () =>
			withForegroundTerminal(renderer, async () => "nested"),
		);
		expect(renderer.calls).toEqual(["suspend", "resume"]);
	});

	test("spawnAndWait reports a successful exit code", async () => {
		const result = await spawnAndWait("true", []);
		expect(result.code).toBe(0);
		expect(result.error).toBeUndefined();
	});

	test("spawnAndWait reports a non-zero exit code", async () => {
		const result = await spawnAndWait("false", []);
		expect(result.code).not.toBe(0);
		expect(result.error).toBeUndefined();
	});

	test("spawnAndWait returns an error result for an unspawnable command", async () => {
		const result = await spawnAndWait("herdr-nonexistent-utility-for-test", []);
		expect(result.error).toBeDefined();
		expect(result.code).toBeUndefined();
	});
});
