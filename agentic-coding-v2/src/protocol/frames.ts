import {
	type Data,
	type Frame,
	type Method,
	type Methods,
	methods,
	record,
	type Snapshot,
	type Transcript,
} from "./index.ts";

const integer = (value: unknown, minimum = 0) =>
	Number.isSafeInteger(value) && Number(value) >= minimum;
const list = (value: unknown): Data[] => {
	if (!Array.isArray(value)) throw new Error("Expected a server list");
	return value.map(record);
};
export function snapshot(value: unknown): Snapshot {
	const data = record(value);
	for (const key of ["tasks", "reviews", "schedules", "profiles", "topics"])
		list(data[key]);
	record(data.environments);
	if (
		!Array.isArray(data.repositories) ||
		!data.repositories.every((path) => typeof path === "string")
	)
		throw new Error("Invalid repository inventory");
	for (const session of list(data.sessions)) {
		if (
			!integer(session.id) ||
			!(session.parent === null || integer(session.parent)) ||
			!(session.task === null || integer(session.task)) ||
			typeof session.title !== "string" ||
			typeof session.writable !== "boolean"
		)
			throw new Error("Invalid session inventory");
	}
	return data as Snapshot;
}
export function transcript(value: unknown): Transcript {
	const data = record(value);
	if (
		!integer(data.id) ||
		!(data.model === null || typeof data.model === "string") ||
		typeof data.thinking !== "string" ||
		typeof data.truncated !== "boolean"
	)
		throw new Error("Invalid native transcript");
	list(data.entries);
	const usage = record(data.usage);
	if (
		!["input", "output", "cacheRead", "cacheWrite", "cost"].every(
			(key) =>
				typeof usage[key] === "number" &&
				Number.isFinite(usage[key]) &&
				Number(usage[key]) >= 0,
		)
	)
		throw new Error("Invalid reported usage");
	return data as Transcript;
}
export function frame(value: unknown): Frame {
	const data = record(value);
	if (data.version !== 1) throw new Error("Unsupported server protocol");
	if (data.type === "hello") {
		if (
			typeof data.connection !== "string" ||
			!Array.isArray(data.methods) ||
			!data.methods.every((method) => methods.includes(method as Method))
		)
			throw new Error("Invalid server capabilities");
	} else if (data.type === "state") {
		if (!integer(data.sequence, 1)) throw new Error("Invalid server sequence");
		snapshot(data.value);
	} else if (data.type === "response") {
		if (typeof data.id !== "string" || !("value" in data))
			throw new Error("Invalid server response");
	} else if (data.type === "error") {
		if (
			!(data.id === null || typeof data.id === "string") ||
			typeof data.message !== "string" ||
			!["invalid-request", "refused", "unavailable"].includes(String(data.code))
		)
			throw new Error("Invalid server refusal");
	} else throw new Error("Unknown server envelope");
	return data as Frame;
}
/** Validate method results before they become client state, not after renderer use. */
export function result<M extends Method>(
	method: M,
	value: unknown,
): Methods[M]["output"] {
	if (method === "state.read") snapshot(value);
	else if (method === "session.read") transcript(value);
	else if (method !== "providers.read" && method !== "environment.logs") {
		const data = record(value);
		const expected =
			method === "state.subscribe"
				? "subscribed"
				: method === "session.abort"
					? "aborted"
					: method === "session.configure"
						? "configured"
						: method === "review.decide"
							? "decided"
							: method === "schedule.delete"
								? "deleted"
								: null;
		if (expected && data[expected] !== true)
			throw new Error("Invalid server acknowledgement");
		if (method === "session.send" && !integer(data.submissionId))
			throw new Error("Invalid submission identity");
		if (
			(method === "session.compact" || method === "environment.action") &&
			!integer(data.taskId)
		)
			throw new Error("Invalid task identity");
		if (method === "task.cancel" && !("requested" in data))
			throw new Error("Invalid cancellation acknowledgement");
	}
	return value as Methods[M]["output"];
}
