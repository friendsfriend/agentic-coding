/** The original transcript toggles work on one *kind* of block at a time: the
 * first press expands every block of that kind, and when any of them is already
 * open the press collapses the whole kind instead. One open card is enough to
 * make the key read as "collapse", so a half-expanded kind never needs two
 * presses of different meaning. */
export function bulkFold(
	identities: string[],
	expanded: string[],
): { ids: string[]; open: boolean } {
	const open = !identities.some((identity) => expanded.includes(identity));
	return { ids: [...identities], open };
}

/** The shell's own merge: a bulk fold replaces what the chosen identities had and
 * leaves every other fold — a card's arguments/output/details, another session's
 * remembered state — exactly where it was. */
export function foldAll(
	expanded: string[],
	identities: string[],
	open: boolean,
): string[] {
	const chosen = new Set(identities);
	const kept = expanded.filter((key) => !chosen.has(key));
	return open ? [...kept, ...identities] : kept;
}
