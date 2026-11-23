import { createHash } from "node:crypto";

/** Stable bridge name for one exact network-only app/target pair. The hash keeps
 * the name within Docker/Podman bounds while preserving the app prefix. */
export function networkName(app: string, target: string) {
	const suffix = createHash("sha256")
		.update(`${app}\0${target}`)
		.digest("hex")
		.slice(0, 12);
	return `environment-mcp-network-${app}-${suffix}`;
}
