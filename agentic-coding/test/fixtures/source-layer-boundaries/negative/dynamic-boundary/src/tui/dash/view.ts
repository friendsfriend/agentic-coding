// Negative fixture: a literal dynamic import() and a literal require() both
// cross a forbidden TUI -> CLI boundary; each must be reported with its
// source and target instead of being ignored.
export async function openCliControl(): Promise<unknown> {
	const start = await import("../../workflow/cli.ts");
	const runner = require("../../workflow/cli/run.ts") as unknown;
	return { start, runner };
}