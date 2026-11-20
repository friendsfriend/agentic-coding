import path from "node:path";
import { definitionProjectLimit } from "../environment/definition-limits.ts";

export function parseMcpOptions(args: string[]) {
	let configDir: string | undefined;
	const repositories: string[] = [];
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!value || value.startsWith("--") || !path.isAbsolute(value))
			throw new Error("Options require absolute paths");
		if (key === "--config-dir" && configDir === undefined) configDir = value;
		else if (key === "--repository") repositories.push(value);
		else throw new Error("Unknown or repeated option");
	}
	if (
		!configDir ||
		repositories.length === 0 ||
		repositories.length > definitionProjectLimit
	)
		throw new Error(
			`Supply --config-dir and 1–${definitionProjectLimit} --repository paths`,
		);
	return { configDir, repositories };
}
