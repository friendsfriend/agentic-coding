import { object } from "../config.ts";
export type Observation = {
	id: string;
	name: string;
	labels: Record<string, unknown>;
	running: boolean;
	exitCode: number;
	health: string | null;
};
/** The caller must provide a private-output, bounded, explicitly targeted CLI invocation.
 * A failed list/inspect never means absence. Name filters are fuzzy; compare exact names.
 */
export async function inspectContainer(
	name: string,
	invoke: (args: string[]) => Promise<string>,
): Promise<Observation | null> {
	const ids = (
		await invoke([
			"container",
			"ls",
			"--all",
			"--no-trunc",
			"--filter",
			`name=${name}`,
			"--format",
			"{{.ID}}",
		])
	)
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (ids.length > 100 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id)))
		throw new Error("Invalid container observation; absence is not confirmed");
	for (const id of new Set(ids)) {
		const encoded = await invoke(["inspect", "--type", "container", id]);
		let raw: unknown;
		try {
			raw = JSON.parse(encoded);
		} catch {
			throw new Error(
				"Invalid private container metadata; raw parser content is omitted",
			);
		}
		if (!Array.isArray(raw) || raw.length !== 1)
			throw new Error("Incomplete container observation");
		const item = object(raw[0]),
			observedName = String(item.Name ?? "").replace(/^\//, "");
		if (observedName !== name) continue;
		const state = object(item.State),
			config = object(item.Config);
		if (
			typeof state.Running !== "boolean" ||
			!Number.isInteger(state.ExitCode) ||
			Number(state.ExitCode) < 0 ||
			Number(state.ExitCode) > 255 ||
			String(item.Id ?? item.ID) !== id
		)
			throw new Error("Invalid container state");
		const health = state.Health ?? state.Healthcheck;
		return {
			id,
			name: observedName,
			labels: config.Labels === null ? {} : object(config.Labels),
			running: state.Running,
			exitCode: Number(state.ExitCode),
			health:
				health && typeof health === "object"
					? String(object(health).Status ?? "")
					: null,
		};
	}
	return null;
}
