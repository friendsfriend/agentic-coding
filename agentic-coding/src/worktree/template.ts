// Shared worktree layout (introduce-worktree-port, design decision 4).
//
// One layout for both layers: `<root>/<ident>/<ident>.<sanitized branch>`, the
// subfolder-per-repository shape the environment layer already uses. The root
// and identifier belong to the caller — the environment layer's
// `$DEVENV_HOME` and app ident, the workflow layer's worktree root and
// repository directory name — so this module never reads ambient
// configuration and the port stays layout-agnostic.
//
// Pure domain: no I/O, no Effect, no ambient clock. `sanitizeBranch` is
// worktrunk's `{{ branch | sanitize }}` filter, so a path computed here and a
// path worktrunk creates are the same string.

/** Worktrunk's `sanitize` filter: `/` and `\` become `-`. */
export function sanitizeBranch(branch: string): string {
	return branch.replaceAll("/", "-").replaceAll("\\", "-");
}

/** The primary (non-linked) worktree directory of one repository. */
export function primaryWorktreePath(root: string, ident: string): string {
	return `${root}/${ident}/${ident}`;
}

/** The linked-worktree directory for one branch. */
export function linkedWorktreePath(
	root: string,
	ident: string,
	branch: string,
): string {
	return `${root}/${ident}/${ident}.${sanitizeBranch(branch)}`;
}

/** The worktrunk `worktree-path` template equivalent to the functions above. */
export function worktreeTemplate(root: string, ident: string): string {
	return `${root}/${ident}/${ident}.{{ branch | sanitize }}`;
}

/** One worktrunk `--config-set` value carrying the layout. The value is a TOML
 * key/value, so the caller passes it as a single argv element and worktrunk
 * expands `{{ branch | sanitize }}` per created worktree. */
export function worktreePathConfig(root: string, ident: string): string {
	return `worktree-path="${escapeTomlString(worktreeTemplate(root, ident))}"`;
}

/** A worktrunk `--config-set` value for one exact path: a template with no
 * variables is a constant, which is how a caller that owns the path (an action
 * step naming its own directory) asks for it. */
export function worktreePathConstant(path: string): string {
	return `worktree-path="${escapeTomlString(path)}"`;
}

function escapeTomlString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
