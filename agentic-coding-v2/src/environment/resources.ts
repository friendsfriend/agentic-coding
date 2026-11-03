import fs from "node:fs";
import path from "node:path";
import { digest } from "../config.ts";
import type { Plan } from "./catalog.ts";

function localSocket(value: string) {
	try {
		return fs.realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}
/** Docker's familiar-name aliases must not create parallel writers of one tag. */
function imageIdentity(value: string) {
	const parts = value.split("/"),
		first = parts[0] ?? "";
	if (
		parts.length === 1 ||
		(!first.includes(".") && !first.includes(":") && first !== "localhost")
	)
		parts.unshift("docker.io");
	if (parts[0] === "index.docker.io") parts[0] = "docker.io";
	if (parts[0] === "docker.io" && parts.length === 2)
		parts.splice(1, 0, "library");
	const image = parts.join("/");
	return image.includes("@") || (parts.at(-1) ?? "").includes(":")
		? image
		: `${image}:latest`;
}
export function runsConflict(left: Plan, right: Plan, stateDir: string) {
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
	// App slots protect runs; image tags are a separate daemon-global write resource.
	if (
		left.action !== "build" ||
		right.action !== "build" ||
		!left.container ||
		!right.container
	)
		return false;
	return (
		localSocket(left.container.socket) ===
			localSocket(right.container.socket) &&
		imageIdentity(left.container.image) === imageIdentity(right.container.image)
	);
}
