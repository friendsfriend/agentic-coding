#!/usr/bin/env bun
// Prints the prompt inventory (src/workflow/prompt-inventory.ts): the bytes and
// rough tokens of every agent role's static first assignment, split into
// protocol sections, role instruction and envelope.
//
//   bun run scripts/prompt-inventory.ts                       Markdown table
//   bun run scripts/prompt-inventory.ts --json                JSON
//   bun run scripts/prompt-inventory.ts --print core.plan:planner
//   bun run scripts/prompt-inventory.ts --system              + system-side rows
//
// It touches no developer state: home, configuration and pi directories are
// fresh temporary directories, set before any module is loaded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-inventory-"));
process.env.HOME = path.join(scratch, "home");
process.env.AGENTIC_CODING_CONFIG_DIR = path.join(scratch, "config");
process.env.PI_CODING_AGENT_DIR = path.join(scratch, "pi");
for (const dir of [
	process.env.HOME,
	process.env.AGENTIC_CODING_CONFIG_DIR,
	process.env.PI_CODING_AGENT_DIR,
])
	fs.mkdirSync(dir, { recursive: true });

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const printIndex = args.indexOf("--print");

try {
	const inventory = await import("../src/workflow/prompt-inventory.ts");
	const rows = inventory.measureInventory();
	if (printIndex >= 0) {
		const target = args[printIndex + 1] ?? "";
		const row = rows.find((item) => `${item.stepId}:${item.role}` === target);
		if (!row) {
			console.error(
				`unknown role ${target}; one of: ${rows.map((item) => `${item.stepId}:${item.role}`).join(" ")}`,
			);
			process.exitCode = 1;
		} else console.log(row.prompt);
	} else {
		const system = flag("--system")
			? await (await import("./prompt-inventory-system.ts")).measureSystem(
					scratch,
				)
			: undefined;
		if (flag("--json"))
			console.log(
				JSON.stringify(
					{
						rows: rows.map(({ prompt: _prompt, ...row }) => row),
						...(system ? { system } : {}),
					},
					null,
					2,
				),
			);
		else {
			console.log(inventory.renderInventoryMarkdown(rows));
			if (system) console.log(`\nSystem side:\n\n${system}`);
		}
	}
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
