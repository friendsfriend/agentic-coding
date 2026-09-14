// `devenv` alias mapping: devenv's verbs and flags expressed as unified
// `agentic-coding` argv. Shared by the unified dispatcher (src/cli.ts) and the
// thin `devenv` launcher (packages/devenv/cli/src/spawn.ts) so both routes map
// identically and neither grows its own copy of the product's command surface.
export const DEVENV_ALIAS_NAMES = new Set([
	"devenv",
	"devenv.ts",
	"devenv-bin",
]);

function flagValue(args: string[], ...flags: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (flags.includes(args[i])) return args[i + 1];
		const inline = flags.find((flag) => args[i].startsWith(`${flag}=`));
		if (inline) return args[i].slice(inline.length + 1);
	}
	return undefined;
}

/**
 * `devenv` keeps working as an alias of the one executable:
 *   devenv [spawn] [-p N]  → unified shell with the backend port carried over
 *   devenv attach <url>    → unified shell attached to that backend
 *   devenv server [-p N]   → headless backend
 */
export function devenvAliasArgv(rest: string[]): string[] {
	// `bin/devenv` passes its own name as the first argument so the unified
	// dispatcher can recognize the alias while `process.argv[1]` stays cli.ts.
	const [first, ...afterName] = rest;
	const args = first === "devenv" ? afterName : rest;
	const [verb, ...tail] = args;
	if (!verb || verb.startsWith("-")) {
		const port = flagValue(args, "-p", "--port");
		return port ? ["--devenv-port", port] : [];
	}
	if (verb === "spawn") {
		const port = flagValue(tail, "-p", "--port");
		return port ? ["--devenv-port", port] : [];
	}
	if (verb === "attach") return ["attach", ...tail];
	if (verb === "server") return ["server", ...tail];
	// Unknown verb: let the unified dispatcher report it.
	return args;
}
