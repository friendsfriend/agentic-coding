// Tool availability probing (`port-action-execution-to-bun`, task 4.2).
//
// Ported from `server/pkg/actionregistry/toolcheck.go`.
//
// Missing tools remove action variants instead of producing an action that
// cannot run, so the probe is the input to the compilers' variant selection.
// The `info` probe matters as much as the lookup: an installed docker binary
// whose daemon is unreachable cannot run a compose file, and reporting it as
// available would compile an action that fails at execution time.
import { execFile } from "node:child_process";
import type { ToolSet } from "./targets.ts";

export interface ToolProbe {
	/** Resolves a binary on PATH, as `exec.LookPath` does. */
	lookPath(name: string): string | undefined;
	/** Whether a container runtime's daemon answers `info` within two seconds. */
	daemonReachable(name: string): boolean | Promise<boolean>;
}

export function defaultToolProbe(): ToolProbe {
	return {
		lookPath: (name) => {
			const found = Bun.which(name);
			return found === null ? undefined : found;
		},
		daemonReachable: (name) =>
			new Promise<boolean>((resolve) => {
				execFile(
					name,
					["info"],
					{ timeout: 2000, killSignal: "SIGKILL" },
					(error) => resolve(error === null),
				);
			}),
	};
}

/** Probes for the tools whose presence decides which action variants exist. */
export async function checkToolAvailability(
	probe: ToolProbe = defaultToolProbe(),
): Promise<ToolSet> {
	const has = (name: string): boolean => probe.lookPath(name) !== undefined;
	const [docker, podman] = await Promise.all(
		["docker", "podman"].map(
			(name) => has(name) && probe.daemonReachable(name),
		),
	);
	return {
		docker,
		podman,
		dockerCompose: has("docker-compose") || has("docker"),
		podmanCompose: has("podman-compose"),
		tmux: has("tmux"),
		kind: has("kind"),
		kubectl: has("kubectl"),
		helm: has("helm"),
	};
}
