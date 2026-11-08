import { evidenceMediaTypes } from "./evidence.ts";
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
import {
	providerCandidate,
	providerReceipt,
} from "./provider-action-frames.ts";
import { nativeViewpoint } from "./viewpoints.ts";

const integer = (value: unknown, minimum = 0) =>
	Number.isSafeInteger(value) && Number(value) >= minimum;
const time = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;
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
function progress(value: unknown) {
	const data = record(value);
	if (data.run !== null) {
		const run = record(data.run);
		if (
			!integer(run.taskId) ||
			!Array.isArray(run.inputs) ||
			!run.inputs.every((id) => integer(id))
		)
			throw new Error("Invalid native run");
	}
	if (data.generation !== null) {
		const generation = record(data.generation);
		if (!integer(generation.attempt))
			throw new Error("Invalid native generation");
		if (generation.message !== undefined) {
			const message = record(generation.message);
			if (message.role !== "assistant")
				throw new Error("Invalid native generation message");
			list(message.content);
		}
		if (generation.retry !== undefined) {
			const retry = record(generation.retry);
			if (!time(retry.at) || typeof retry.error !== "string")
				throw new Error("Invalid native retry");
		}
		if (
			generation.deferred !== undefined &&
			!time(record(generation.deferred).pollAt)
		)
			throw new Error("Invalid native deferred poll");
	}
	for (const key of ["tools", "nestedTools"])
		for (const slot of list(data[key])) {
			if (
				typeof slot.callId !== "string" ||
				typeof slot.name !== "string" ||
				!["pending", "running", "done"].includes(String(slot.status))
			)
				throw new Error("Invalid native tool progress");
			for (const field of [
				"taskId",
				"entry",
				"droppedBytes",
				"droppedLines",
				"parentTaskId",
			])
				if (slot[field] !== undefined && !integer(slot[field]))
					throw new Error("Invalid native tool identity/count");
			if (slot.output !== undefined && typeof slot.output !== "string")
				throw new Error("Invalid native tool output");
			if (slot.arguments !== undefined) record(slot.arguments);
			if (slot.summary !== undefined) {
				const summary = record(slot.summary);
				if (
					typeof summary.isError !== "boolean" ||
					(summary.durationMs !== undefined && !time(summary.durationMs))
				)
					throw new Error("Invalid native nested summary");
			}
			if (
				key === "nestedTools" &&
				(!integer(slot.taskId) ||
					!integer(slot.parentTaskId) ||
					typeof slot.parentCallId !== "string")
			)
				throw new Error("Invalid native nested tool relationship");
			if (slot.diagnostics !== undefined)
				for (const item of list(slot.diagnostics))
					if (
						typeof item.message !== "string" ||
						!["info", "warn", "error"].includes(String(item.severity))
					)
						throw new Error("Invalid native diagnostic");
		}
	for (const item of list(data.compactions))
		if (
			!integer(item.taskId) ||
			!integer(item.attempt) ||
			typeof item.reason !== "string" ||
			typeof item.blocking !== "boolean"
		)
			throw new Error("Invalid native compaction");
	if (data.compactionFailure !== null) {
		const failure = record(data.compactionFailure);
		if (
			!integer(failure.taskId) ||
			typeof failure.reason !== "string" ||
			typeof failure.error !== "string"
		)
			throw new Error("Invalid native compaction failure");
	}
	for (const item of list(data.inbox))
		if (
			!integer(item.id) ||
			!["steer", "followUp", "write"].includes(String(item.mode))
		)
			throw new Error("Invalid native inbox");
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
	progress(data.progress);
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
	} else if (data.type === "session" || data.type === "session-unavailable") {
		if (
			!integer(data.sequence, 1) ||
			typeof data.watchId !== "string" ||
			!/^[a-zA-Z0-9:_-]{1,128}$/.test(data.watchId)
		)
			throw new Error("Invalid session publication");
		if (data.type === "session") transcript(data.value);
		else if (typeof data.message !== "string")
			throw new Error("Invalid session availability");
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
	const standaloneSession = (value: unknown) => {
		const data = record(value);
		if (
			typeof data.id !== "string" ||
			!/^[a-f0-9-]{36}$/.test(data.id) ||
			!["pi", "opencode"].includes(String(data.mode)) ||
			!["ready", "busy", "uncertain", "closed"].includes(String(data.status)) ||
			!integer(data.revision, 1) ||
			typeof data.title !== "string" ||
			data.title.length > 256 ||
			typeof data.repository !== "string" ||
			typeof data.profile !== "string" ||
			typeof data.truncated !== "boolean" ||
			(data.partial !== null &&
				(typeof data.partial !== "string" || data.partial.length > 64000)) ||
			!Array.isArray(data.messages) ||
			data.messages.length > 100 ||
			JSON.stringify(data.messages).length > 96000 ||
			["backend", "context", "attempts", "token", "url"].some((key) =>
				Object.hasOwn(data, key),
			)
		)
			throw new Error("Invalid standalone observation");
		for (const message of list(data.messages))
			if (
				!["user", "assistant"].includes(String(message.role)) ||
				typeof message.content !== "string" ||
				message.content.length > 64000
			)
				throw new Error("Invalid standalone message");
	};
	if (method === "standalone.read") {
		const data = record(value);
		if (
			typeof data.piAvailable !== "boolean" ||
			typeof data.opencodeAvailable !== "boolean" ||
			typeof data.scope !== "string" ||
			!Array.isArray(data.sessions) ||
			data.sessions.length > 64
		)
			throw new Error("Invalid standalone inventory");
		data.sessions.forEach(standaloneSession);
	} else if (
		method === "standalone.create" ||
		method === "standalone.send" ||
		method === "standalone.compact"
	)
		standaloneSession(value);
	else if (method === "standalone.abort" && record(value).aborted !== true)
		throw new Error("Invalid standalone abort");
	else if (
		method === "standalone.configure" &&
		record(value).configured !== true
	)
		throw new Error("Invalid standalone configuration");
	else if (method === "standalone.retire" && record(value).retired !== true)
		throw new Error("Invalid standalone retirement");
	else if (method === "environment.preview") {
		const data = record(value);
		if (
			typeof data.id !== "string" ||
			!/^[a-f0-9-]{36}$/.test(data.id) ||
			typeof data.digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(data.digest) ||
			typeof data.snapshot !== "string" ||
			data.snapshot.length > 96000 ||
			!time(data.expiresAt)
		)
			throw new Error("Invalid environment candidate");
	} else if (method === "providers.preview") providerCandidate(value);
	else if (method === "providers.apply" || method === "providers.receipt")
		providerReceipt(value);
	else if (method === "providers.actions") {
		const items = list(value);
		if (items.length > 256)
			throw new Error("Provider journal capacity exceeded");
		items.forEach(providerReceipt);
	} else if (method === "viewpoints.read") {
		const items = list(value);
		if (items.length > 32)
			throw new Error("Native viewpoint capacity exceeded");
		items.forEach(nativeViewpoint);
	} else if (method === "viewpoints.save") nativeViewpoint(value);
	else if (method === "viewpoints.remove") {
		if (record(value).removed !== true)
			throw new Error("Invalid native viewpoint deletion");
	} else if (method === "session.history") {
		const data = record(value),
			entries = list(data.entries);
		if (
			!integer(data.id) ||
			entries.length > 50 ||
			!(
				data.cursor === null ||
				(typeof data.cursor === "string" && /^[a-f0-9-]{36}$/.test(data.cursor))
			)
		)
			throw new Error("Invalid native history page");
		const identities = new Set<number>();
		for (const entry of entries) {
			if (
				!integer(entry.id) ||
				typeof entry.kind !== "string" ||
				identities.has(Number(entry.id))
			)
				throw new Error("Invalid or duplicate history entry");
			identities.add(Number(entry.id));
		}
	} else if (method === "evidence.read") {
		const data = record(value);
		if (
			typeof data.id !== "string" ||
			!/^[a-f0-9]{64}$/.test(data.id) ||
			!integer(data.taskId) ||
			!evidenceMediaTypes.some((type) => type === data.mediaType) ||
			typeof data.caption !== "string" ||
			typeof data.content !== "string" ||
			data.content.length > 512000 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				data.content,
			) ||
			!integer(data.offset) ||
			!integer(data.totalBytes, 1) ||
			Number(data.totalBytes) > 10_000_000 ||
			Number(data.offset) >= Number(data.totalBytes) ||
			(data.nextOffset !== null &&
				(!integer(data.nextOffset) ||
					Number(data.nextOffset) <= Number(data.offset) ||
					Number(data.nextOffset) >= Number(data.totalBytes)))
		)
			throw new Error("Invalid native evidence");
		const encoded = String(data.content),
			bytes =
				(encoded.length / 4) * 3 -
				(encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0),
			end = Number(data.offset) + bytes;
		if (
			bytes < 1 ||
			end > Number(data.totalBytes) ||
			(data.nextOffset === null
				? end !== data.totalBytes
				: end !== data.nextOffset) ||
			(String(data.mediaType).startsWith("image/") &&
				(data.offset !== 0 || data.nextOffset !== null))
		)
			throw new Error("Invalid evidence byte window");
	} else if (method.startsWith("wiki.")) {
		const page = (value: unknown, content: boolean) => {
			const data = record(value);
			if (
				typeof data.id !== "string" ||
				typeof data.title !== "string" ||
				!integer(data.revision, 1) ||
				typeof data.digest !== "string" ||
				data.digest.length !== 64 ||
				!/^[a-f0-9]{64}$/.test(data.digest) ||
				!integer(data.updatedAt, 1) ||
				(content &&
					(typeof data.content !== "string" || data.content.length > 32000))
			)
				throw new Error("Invalid wiki page");
		};
		if (method === "wiki.list") {
			const entries = list(value);
			if (entries.length > 64) throw new Error("Invalid wiki list");
			for (const entry of entries) page(entry, false);
		} else if (method === "wiki.read") {
			const data = record(value);
			page(data.page, true);
			const comments = list(data.comments);
			if (comments.length > 128) throw new Error("Invalid wiki comments");
			comments.forEach((comment) => {
				if (
					typeof comment.id !== "string" ||
					typeof comment.pageId !== "string" ||
					!integer(comment.pageRevision, 1) ||
					typeof comment.comment !== "string" ||
					comment.comment.length > 4000 ||
					!(comment.taskId === null || integer(comment.taskId, 0))
				)
					throw new Error("Invalid wiki comment");
			});
		} else if (method === "wiki.apply") page(value, true);
		else if (method === "wiki.comment") {
			if (!integer(record(value).taskId, 0))
				throw new Error("Invalid comment task");
		} else {
			const data = record(value);
			if (
				typeof data.id !== "string" ||
				typeof data.snapshot !== "string" ||
				data.snapshot.length > 64000 ||
				typeof data.digest !== "string" ||
				data.digest.length !== 64 ||
				!/^[a-f0-9]{64}$/.test(data.digest) ||
				!integer(data.expiresAt, 1)
			)
				throw new Error("Invalid wiki candidate");
		}
	} else if (method.startsWith("skill-file.")) {
		const data = record(value);
		if (
			typeof data.name !== "string" ||
			!/^[a-z][a-z0-9-]{0,63}$/.test(data.name) ||
			data.restartRequired !== true
		)
			throw new Error("Invalid skill file identity");
		const revision =
			method === "skill-file.preview" ? data.baseRevision : data.revision;
		if (
			typeof revision !== "string" ||
			!(revision === "missing" || /^[a-f0-9]{64}$/.test(revision))
		)
			throw new Error("Invalid skill file revision");
		if (
			method !== "skill-file.apply" &&
			(typeof data.content !== "string" ||
				data.content.length > 64000 ||
				typeof data.directoryIdentity !== "string" ||
				data.directoryIdentity.length > 256)
		)
			throw new Error("Invalid skill file text/identity");
		if (
			method === "skill-file.preview" &&
			(typeof data.id !== "string" ||
				data.id.length > 80 ||
				typeof data.snapshot !== "string" ||
				data.snapshot.length > 400000 ||
				typeof data.digest !== "string" ||
				!/^[a-f0-9]{64}$/.test(data.digest) ||
				typeof data.expiresAt !== "number" ||
				!Number.isSafeInteger(data.expiresAt))
		)
			throw new Error("Invalid skill file candidate");
	} else if (method === "skills.read" || method === "skill.read") {
		const entries = method === "skills.read" ? list(value) : [record(value)];
		if (
			entries.length > 128 ||
			new Set(entries.map((entry) => entry.id)).size !== entries.length
		)
			throw new Error("Invalid skill catalog");
		for (const entry of entries) {
			if (
				typeof entry.id !== "string" ||
				!entry.id ||
				entry.id.length > 128 ||
				!["system", "user"].includes(String(entry.origin)) ||
				typeof entry.description !== "string" ||
				entry.description.length > 2048 ||
				typeof entry.revision !== "string" ||
				entry.revision.length !== 64 ||
				!/^[a-f0-9]{64}$/.test(entry.revision) ||
				typeof entry.readOnly !== "boolean"
			)
				throw new Error("Invalid skill metadata");
			if (
				method === "skill.read" &&
				(typeof entry.content !== "string" || entry.content.length > 64000)
			)
				throw new Error("Invalid skill instructions");
		}
	} else if (method === "settings.read") {
		const data = record(value),
			settings = record(data.settings);
		if (
			typeof data.revision !== "string" ||
			data.restartRequired !== true ||
			typeof settings.orchestratorProfile !== "string" ||
			!Array.isArray(settings.repositories) ||
			!settings.repositories.every((repo) => typeof repo === "string")
		)
			throw new Error("Invalid settings document");
		Object.values(record(settings.profiles)).forEach((raw) => {
			const profile = record(raw);
			if (
				typeof profile.model !== "string" ||
				typeof profile.thinking !== "string" ||
				typeof profile.description !== "string"
			)
				throw new Error("Invalid settings profile");
		});
		list(settings.providers).forEach((provider) => {
			if (
				typeof provider.name !== "string" ||
				!["github", "gitlab"].includes(String(provider.type)) ||
				typeof provider.baseUrl !== "string" ||
				(provider.username !== undefined &&
					typeof provider.username !== "string") ||
				(provider.tokenRef !== undefined &&
					typeof provider.tokenRef !== "string")
			)
				throw new Error("Invalid provider setting");
		});
	} else if (method === "settings.preview") {
		const data = record(value);
		if (
			typeof data.id !== "string" ||
			typeof data.baseRevision !== "string" ||
			typeof data.digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(data.digest) ||
			typeof data.snapshot !== "string" ||
			data.snapshot.length > 128000 ||
			!Number.isSafeInteger(data.expiresAt) ||
			data.restartRequired !== true
		)
			throw new Error("Invalid settings candidate");
	} else if (method === "settings.apply") {
		const data = record(value);
		if (typeof data.revision !== "string" || data.restartRequired !== true)
			throw new Error("Invalid settings receipt");
	} else if (method === "providers.read") {
		list(value).forEach((provider) => {
			if (
				typeof provider.name !== "string" ||
				!["github", "gitlab"].includes(String(provider.type)) ||
				typeof provider.baseUrl !== "string" ||
				typeof provider.username !== "string" ||
				typeof provider.has_token !== "boolean"
			)
				throw new Error("Invalid provider registry");
		});
	} else if (method === "providers.inspect") {
		const data = record(value);
		if (
			typeof data.provider !== "string" ||
			![
				"repos",
				"branches",
				"labels",
				"collaborators",
				"changes",
				"issues",
				"change",
				"issue",
				"files",
				"versions",
				"discussions",
				"jobs",
			].includes(String(data.operation))
		)
			throw new Error("Invalid provider inspection");
		if (Array.isArray(data.value)) list(data.value);
		else record(data.value);
	} else if (method === "state.read") snapshot(value);
	else if (method === "session.read") transcript(value);
	else if (method === "task.read") {
		const data = record(value);
		if (!integer(data.id) || record(data.metadata).id !== data.id)
			throw new Error("Invalid task detail identity");
		list(data.reviews).forEach((review) => {
			if (
				review.taskId !== data.id ||
				typeof review.id !== "string" ||
				!integer(review.revision, 1) ||
				typeof review.snapshot !== "string" ||
				typeof review.digest !== "string" ||
				typeof review.title !== "string" ||
				typeof review.comments !== "string" ||
				![
					"pending",
					"approved",
					"rejected",
					"changes-requested",
					"cancelled",
				].includes(String(review.state))
			)
				throw new Error("Invalid task review");
		});
		const work = record(data.ownedWork);
		if (typeof work.truncated !== "boolean")
			throw new Error("Invalid owned work inspection");
		const seenWork = new Set<number>();
		const workers = list(work.items);
		if (workers.length > 128)
			throw new Error("Owned work inspection exceeds bound");
		workers.forEach((node, index) => {
			if (
				!integer(node.id) ||
				seenWork.has(Number(node.id)) ||
				!integer(node.conversationId) ||
				typeof node.state !== "string" ||
				!(node.until === null || integer(node.until)) ||
				!(
					node.reason === null ||
					(typeof node.reason === "string" && node.reason.length <= 2048)
				) ||
				typeof node.reasonTruncated !== "boolean" ||
				(index === 0
					? node.id !== data.id || node.parent !== null
					: !integer(node.parent) || !seenWork.has(Number(node.parent)))
			)
				throw new Error("Invalid scoped owned work node");
			seenWork.add(Number(node.id));
		});
		list(data.attachments).forEach((item) => {
			if (
				item.taskId !== data.id ||
				typeof item.id !== "string" ||
				!/^[a-f0-9]{64}$/.test(item.id) ||
				typeof item.caption !== "string" ||
				!evidenceMediaTypes.some((type) => type === item.mediaType)
			)
				throw new Error("Invalid task attachment");
		});
		if (data.native !== null) {
			const native = record(data.native);
			if (
				typeof native.status !== "string" ||
				typeof native.abortRequested !== "boolean"
			)
				throw new Error("Invalid native task status");
			if (native.outcome !== null) record(native.outcome);
		}
	} else if (method === "session.watch") {
		const data = record(value);
		if (
			!(data.id === null || integer(data.id)) ||
			typeof data.watchId !== "string" ||
			!/^[a-zA-Z0-9:_-]{1,128}$/.test(data.watchId)
		)
			throw new Error("Invalid session watch acknowledgement");
	} else if (
		method === "environment.inspect" ||
		method === "environment.apply"
	) {
		if (Array.isArray(value)) list(value);
		else record(value);
	} else if (method !== "providers.read" && method !== "environment.logs") {
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
