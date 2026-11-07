import { record } from "./index.ts";
export function providerCandidate(value: unknown) {
	const data = record(value);
	if (
		Object.keys(data).some(
			(key) =>
				!["id", "provider", "snapshot", "digest", "expiresAt"].includes(key),
		) ||
		typeof data.id !== "string" ||
		typeof data.provider !== "string" ||
		typeof data.snapshot !== "string" ||
		data.snapshot.length > 32000 ||
		typeof data.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(data.digest) ||
		!Number.isSafeInteger(data.expiresAt)
	)
		throw new Error("Invalid provider candidate");
}
export function providerReceipt(value: unknown) {
	const data = record(value);
	if (
		Object.keys(data).some(
			(key) =>
				![
					"id",
					"provider",
					"operation",
					"target",
					"destination",
					"digest",
					"status",
					"result",
					"updatedAt",
				].includes(key),
		) ||
		typeof data.id !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(data.id) ||
		typeof data.provider !== "string" ||
		typeof data.operation !== "string" ||
		typeof data.target !== "string" ||
		data.target.length > 256 ||
		typeof data.destination !== "string" ||
		data.destination.length > 1024 ||
		typeof data.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(data.digest) ||
		!["acknowledged", "uncertain"].includes(String(data.status)) ||
		!Number.isSafeInteger(data.updatedAt) ||
		!Object.hasOwn(data, "result") ||
		JSON.stringify(data.result).length > 32000
	)
		throw new Error("Invalid provider attempt receipt");
	if (data.status === "acknowledged") record(data.result);
	else if (data.result !== null)
		throw new Error("Uncertain provider result must remain unknown");
}
