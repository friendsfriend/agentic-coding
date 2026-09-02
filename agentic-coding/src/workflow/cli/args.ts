// argv parsing primitives shared by every CLI command handler. Moved
// verbatim out of cli.ts (split-workflow-god-modules).
import fs from "node:fs";

export function requireFlag(argv: string[], name: string): string {
	const value = flag(argv, name);
	if (value === undefined) throw new Error(`missing required flag --${name}`);
	return value;
}
export function flag(argv: string[], name: string): string | undefined {
	const exact = argv.indexOf(`--${name}`);
	if (exact !== -1) return argv[exact + 1];
	const prefix = `--${name}=`;
	return argv.find((token) => token.startsWith(prefix))?.slice(prefix.length);
}
export function positionals(argv: string[]): string[] {
	const values: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) values.push(token);
		else if (!token.includes("=") && !["--clean", "--confirm"].includes(token))
			i++;
	}
	return values;
}
export function positional(argv: string[]): string | undefined {
	return positionals(argv)[0];
}
export function parseInput(value?: string): unknown {
	if (!value) return undefined;
	const text = fs.existsSync(value) ? fs.readFileSync(value, "utf8") : value;
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("--input must be JSON or path to JSON");
	}
}
export function parseInlineJson(value: string, name: string): unknown {
	if (value.length > 128 * 1024)
		throw new Error(`${name} must be inline JSON no larger than 128 KiB`);
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`${name} must be valid inline JSON`);
	}
}
