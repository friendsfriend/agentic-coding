import fs from "node:fs";
import path from "node:path";
import { digest } from "../config.ts";
import type { Plan } from "./catalog.ts";
import { containerPlans } from "./compose-config.ts";

function localSocket(value: string) {
	try {
		return fs.realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}
export function runsConflict(left: Plan, right: Plan, stateDir: string) {
	if (left.app === right.app) return true;
	return containerPlans(left).some((a) =>
		containerPlans(right).some((b) => containerConflict(a, b, stateDir)),
	);
}
function containerConflict(left: Plan, right: Plan, stateDir: string) {
	if (left.app === right.app) return true;
	if (!left.container || !right.container) return false;
	const name = (plan: Plan) =>
		plan.container?.name ?? `acv2-${plan.app}-${digest(stateDir).slice(0, 8)}`;
	if (
		localSocket(left.container.socket) ===
			localSocket(right.container.socket) &&
		name(left) === name(right)
	)
		return true;
	return left.container.ports.some((a) =>
		right.container?.ports.some(
			(b) =>
				a.host === b.host &&
				a.protocol === b.protocol &&
				(a.address === b.address ||
					[a.address, b.address].some(
						(address) => address === "0.0.0.0" || address === "::",
					)),
		),
	);
}
export function actionsConflict(left: Plan, right: Plan) {
	if (
		left.workspace === right.workspace &&
		left.action !== "run" &&
		right.action !== "run"
	)
		return true;
	// App slots protect runs; image writes are a separate daemon-global resource.
	// Do not guess tag identity from the client family: Docker may talk to a
	// Podman compatibility socket, and Podman short-name aliases depend on host policy.
	// Serialize all image writers on one socket until canonical backend identity is proven.
	if (
		left.action !== "build" ||
		right.action !== "build" ||
		!left.container ||
		!right.container
	)
		return false;
	return (
		localSocket(left.container.socket) === localSocket(right.container.socket)
	);
}
