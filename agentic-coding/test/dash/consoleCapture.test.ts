// Focused coverage for the scoped console capture used by the agent
// configuration editor: it must forward warn/error to the caller, keep the
// message bounded, suppress TUI overlay printing while active, and restore the
// original console methods on dispose.
import { expect, test } from "bun:test";
import {
	captureConsoleIssues,
	formatConsoleIssue,
} from "../../src/tui/dash/consoleCapture";

test("formatConsoleIssue flattens arguments and bounds the message", () => {
	expect(formatConsoleIssue(["a", new Error("b"), { c: 1 }])).toBe(
		'a b {"c":1}',
	);
	expect(formatConsoleIssue(["line\nbreak", 2])).toBe("line break 2");
	const bounded = formatConsoleIssue(["x".repeat(600)]);
	expect(bounded).toHaveLength(501);
	expect(bounded.endsWith("…")).toBe(true);
});

test("captureConsoleIssues forwards warn/error, suppresses printing, and restores on dispose", () => {
	const issues: Array<{ level: string; message: string }> = [];
	const printed: string[] = [];
	const originalWarn = console.warn;
	const originalError = console.error;
	console.warn = (...args: unknown[]) => {
		printed.push(`warn:${args.join(" ")}`);
	};
	console.error = (...args: unknown[]) => {
		printed.push(`error:${args.join(" ")}`);
	};
	try {
		const dispose = captureConsoleIssues((issue) => issues.push(issue));
		console.warn("potential leak");
		console.error("failed", new Error("boom"));

		expect(issues).toEqual([
			{ level: "warn", message: "potential leak" },
			{ level: "error", message: "failed boom" },
		]);
		// While captured, nothing reaches the TUI console overlay.
		expect(printed).toEqual([]);

		dispose();
		console.warn("after dispose");
		console.error("after dispose error");
		expect(printed).toEqual([
			"warn:after dispose",
			"error:after dispose error",
		]);
	} finally {
		console.warn = originalWarn;
		console.error = originalError;
	}
});
