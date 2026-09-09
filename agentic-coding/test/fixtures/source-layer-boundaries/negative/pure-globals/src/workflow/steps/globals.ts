// Negative fixture: recognized ambient I/O/clock globals in a guarded pure
// module must be reported with their source locations.
export function readAmbient(input: string): string {
	Bun.spawnSync(["echo", input]);
	const fetched = fetch("https://example.test");
	const now = Date.now();
	const stamp = new Date();
	process.cwd();
	return `${fetched}${now}${stamp}${input}`;
}