import { createHash } from "node:crypto";

export type EnvironmentOwner = "user" | `workflow:${string}`;

export type EnvironmentInstanceStatus =
	| "starting"
	| "running"
	| "stopping"
	| "stopped"
	| "failed"
	| "unknown"
	/** The developer force-released the app; the holder reads this once. */
	| "released-by-developer"
	/**
	 * A parallel-era row the v9 collapse retired without observing it: it no
	 * longer holds the app's slot, and nothing claims its run is gone. Only
	 * reconcile or a developer release/stop may confirm it as `stopped`.
	 */
	| "superseded";

export class EnvironmentInstanceModelError extends Error {
	readonly code = "invalid-owner";
	constructor(message: string) {
		super(message);
		this.name = "EnvironmentInstanceModelError";
	}
}

/** Accept only the two owner forms the environment capability supports. */
function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

export function parseEnvironmentOwner(value: string): EnvironmentOwner {
	if (value.length > 512 || hasControlCharacters(value))
		throw new EnvironmentInstanceModelError(
			"owner must be at most 512 characters and contain no control characters",
		);
	if (value === "user") return value;
	if (
		value.startsWith("workflow:") &&
		value.slice("workflow:".length).trim() !== ""
	)
		return value as EnvironmentOwner;
	throw new EnvironmentInstanceModelError(
		`owner must be "user" or "workflow:<id>", received ${JSON.stringify(value)}`,
	);
}

/** A bounded, stable, owner- and app-scoped identifier suitable for names. */
export function environmentInstanceId(ownerValue: string, app: string): string {
	const owner = parseEnvironmentOwner(ownerValue);
	if (app.length === 0 || app.length > 512 || hasControlCharacters(app))
		throw new EnvironmentInstanceModelError(
			"app must be a non-empty value of at most 512 characters without control characters",
		);
	if (owner === "user") return "default";
	const ownerId = owner.slice("workflow:".length);
	const slug = `${ownerId}-${app}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 7)
		.replace(/-+$/g, "");
	const suffix = createHash("sha256")
		.update(`${owner}\0${app}`)
		.digest("hex")
		.slice(0, 16);
	return `${slug || "instanc"}-${suffix}`;
}

/** Internal durable key; user-facing identity stays `default` per app. */
export function environmentInstanceStorageId(
	ownerValue: string,
	app: string,
): string {
	const owner = parseEnvironmentOwner(ownerValue);
	if (owner === "user") {
		environmentInstanceId(owner, app); // validate the app even though the public id is fixed.
		return `user-${app}-default`;
	}
	return environmentInstanceId(owner, app);
}

export interface EnvironmentInstance {
	readonly id: string;
	readonly owner: EnvironmentOwner;
	readonly app: string;
	readonly targetId: string;
	readonly runtime: string;
	readonly checkoutPath: string;
	readonly configOverlay?: string;
	readonly imageTag: string;
	readonly status: EnvironmentInstanceStatus;
	readonly createdAt: string;
	readonly lastActivityAt: string;
	/** The definition's own static endpoint exports. */
	readonly endpoints: Readonly<Record<string, string>>;
}
