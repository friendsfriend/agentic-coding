import fs from "node:fs";
import path from "node:path";
import { digest } from "../config.ts";
import { containerPlans } from "./compose-config.ts";
import type { Plan } from "./model.ts";

function localSocket(value: string) {
	try {
		return fs.realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}
function ports(plan: Plan) {
	return containerPlans(plan).flatMap<{
		host: number;
		protocol: string;
		address: string;
	}>((service) => [
		...(service.container?.ports ??
			Object.values(service.endpoints ?? {}).map((address) => {
				const url = new URL(address);
				return {
					host: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
					protocol: "tcp",
					address: url.hostname.replace(/^\[|\]$/g, ""),
				};
			})),
		...(service.readyUrl
			? [
					{
						host: Number(
							new URL(service.readyUrl).port ||
								(new URL(service.readyUrl).protocol === "https:" ? 443 : 80),
						),
						protocol: "tcp",
						address: new URL(service.readyUrl).hostname.replace(/^\[|\]$/g, ""),
					},
				]
			: []),
		...(service.kubernetes?.portForwards ?? []).map((forward) => ({
			host: forward.local,
			protocol: "tcp",
			address: "127.0.0.1",
		})),
		...(service.queryConnection
			? [
					{
						host: service.queryConnection.port,
						protocol: "tcp",
						address: service.queryConnection.host,
					},
				]
			: []),
	]);
}
export function runsConflict(left: Plan, right: Plan, stateDir: string) {
	if (left.app === right.app) return true;
	if (
		left.compose &&
		right.compose &&
		localSocket(left.compose.socket) === localSocket(right.compose.socket) &&
		left.composePlan?.volumes?.some((a) =>
			right.composePlan?.volumes?.some((b) => a.scope === b.scope),
		)
	)
		return true;
	if (
		ports(left).some((a) =>
			ports(right).some(
				(b) =>
					a.host === b.host &&
					a.protocol === b.protocol &&
					(a.address === b.address ||
						[a.address, b.address].some(
							(address) => address === "0.0.0.0" || address === "::",
						)),
			),
		)
	)
		return true;
	return containerPlans(left).some((a) =>
		containerPlans(right).some((b) => containerNameConflict(a, b, stateDir)),
	);
}
function containerNameConflict(left: Plan, right: Plan, stateDir: string) {
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
	return false;
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
