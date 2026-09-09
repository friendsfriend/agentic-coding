// Negative fixture: a guarded pure module importing an I/O builtin directly.
import fs from "node:fs";

export function readCwd(): string {
	return fs.readdirSync(".").join(",");
}