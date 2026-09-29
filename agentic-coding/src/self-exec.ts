// Re-executing this application: a compiled `agentic-coding` binary runs
// itself, while a source run re-execs this package's CLI entry.
//
// `Bun.main` is not a reliable compiled/source discriminator on its own: a
// single-file compile reports `$bunfs/...`, but a bundled build reports the
// executable path, and passing that path as the first argument makes the child
// answer `unknown agentic-coding command: <path>`. The executable-name check
// closes that gap, and every self-re-exec (bounded catalog read, detached
// workflow drain) goes through here so the two can never drift.

/** True when this process is the compiled binary rather than a source run. The
 * arguments are injectable so the compiled/source discrimination is testable. */
export function isCompiledBinary(
	main: string = Bun.main,
	execPath: string = process.execPath,
): boolean {
	return main.startsWith("$bunfs") || execPath.endsWith("agentic-coding");
}

/** The entry argument a self-re-exec needs: `undefined` for the compiled
 * binary (it runs itself), the CLI source entry otherwise. */
export function selfExecEntry(
	main: string = Bun.main,
	execPath: string = process.execPath,
): string | undefined {
	return isCompiledBinary(main, execPath) ? undefined : main;
}
