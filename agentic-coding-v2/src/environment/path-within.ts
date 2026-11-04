import path from "node:path";

/** Lexical containment only: callers own realpath/link/symlink checks. */
export function within(parent: string, child: string) {
	const relative = path.relative(parent, child);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}
