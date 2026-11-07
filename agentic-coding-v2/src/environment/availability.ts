import fs from "node:fs";
import path from "node:path";
import type { Availability, Target } from "./model.ts";

const result = (
	eligible: boolean | null,
	reason: string,
	executable?: string,
): Availability => ({
	eligible,
	reason,
	probe: "not-performed",
	...(executable ? { executable } : {}),
});
function executable(file: string) {
	try {
		if (!fs.statSync(file).isFile()) return false;
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/** Metadata only: never launch a CLI, connect to a daemon, resolve secrets, or infer readiness. */
export function targetAvailability(target: Target): Availability {
	if (process.platform === "win32")
		return result(false, "This runtime adapter requires POSIX");
	if (target.runtime === "shell")
		return executable("/bin/sh")
			? result(
					true,
					"POSIX shell is executable; startup is not verified",
					"/bin/sh",
				)
			: result(false, "POSIX shell is not executable");
	if (target.runtime === "kubernetes")
		return result(
			null,
			"Kubernetes requires explicit context approval; client/API readiness is not probed",
		);
	const runtime = target.compose?.provider ?? target.runtime;
	const socket = target.compose?.socket ?? target.container?.socket;
	if (!socket) return result(false, "An explicit local API socket is required");
	try {
		if (!fs.statSync(socket).isSocket())
			return result(false, "Configured API path is not a Unix socket");
		fs.accessSync(socket, fs.constants.R_OK | fs.constants.W_OK);
	} catch {
		return result(
			false,
			"Configured local API socket is absent or inaccessible",
		);
	}
	if ("PATH" in target.secretRefs)
		return result(
			null,
			"Client PATH requires an approved secret reference; no secret was resolved",
		);
	const paths = (
		target.environment.PATH ??
		process.env.PATH ??
		"/usr/local/bin:/usr/bin:/bin"
	).split(path.delimiter);
	// A relative PATH entry can shadow a later program in a task-specific checkout.
	if (paths.some((entry) => !path.isAbsolute(entry)))
		return result(null, "Relative client PATH requires task-time resolution");
	const program = paths
		.map((entry) => path.join(entry, runtime))
		.find(executable);
	return program
		? result(
				true,
				"Client and socket metadata are eligible; daemon connectivity, health and permissions are not probed",
				program,
			)
		: result(false, `Configured ${runtime} client is not executable on PATH`);
}
