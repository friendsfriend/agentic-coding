import { describe, expect, spyOn, test } from "bun:test";
import { directionBetween, runHerdr } from "../src/herdr-client.ts";

function mockSpawn(stdout: string, exitCode = 0, stderr = "") {
	return spyOn(Bun, "spawnSync").mockReturnValue({
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
		exitCode,
		// biome-ignore lint/suspicious/noExplicitAny: partial spawn result stub
	} as any);
}

describe("runHerdr", () => {
	test("parses the .result envelope", () => {
		const spy = mockSpawn(
			JSON.stringify({ result: { workspaces: [{ workspace_id: "w1" }] } }),
		);
		expect(runHerdr(["workspace", "list"])).toEqual({
			workspaces: [{ workspace_id: "w1" }],
		});
		spy.mockRestore();
	});

	test("returns {} for empty stdout", () => {
		const spy = mockSpawn("");
		expect(runHerdr(["pane", "close", "p1"])).toEqual({});
		spy.mockRestore();
	});

	test("throws with stderr detail on non-zero exit", () => {
		const spy = mockSpawn("", 1, "pane not found");
		expect(() => runHerdr(["pane", "get", "missing"])).toThrow(
			/pane not found/,
		);
		spy.mockRestore();
	});
});

describe("directionBetween", () => {
	const rect = (x: number, y: number, width = 10, height = 10) => ({
		x,
		y,
		width,
		height,
	});

	test("picks the dominant axis toward the target rect", () => {
		expect(directionBetween(rect(0, 0), rect(20, 0))).toBe("right");
		expect(directionBetween(rect(20, 0), rect(0, 0))).toBe("left");
		expect(directionBetween(rect(0, 0), rect(0, 20))).toBe("down");
		expect(directionBetween(rect(0, 20), rect(0, 0))).toBe("up");
	});
});
