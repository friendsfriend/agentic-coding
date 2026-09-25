// Negative fixture: recognized ambient I/O/clock globals in a guarded pure
// module must be reported with their source locations.
export function readAmbient(input: string): string {
	Bun.spawnSync(["echo", input]);
	const fetched = fetch("https://example.test");
	const now = Date.now();
	const stamp = new Date();
	process.cwd();
	// Optional-chained forms parse as OptionalCallExpression /
	// OptionalMemberExpression; the guard must still recognize them.
	fetch?.("https://example.test");
	Date?.now();
	process?.exit(1);
	Bun?.file(input);
	return `${fetched}${now}${stamp}${input}`;
}