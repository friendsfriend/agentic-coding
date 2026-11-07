import { defineDoc } from "@earendil-works/pi-durable";
import { digest } from "../config.ts";
import { stored } from "../environment/definition-draft-data.ts";

export type ProviderWriteData = {
	/** key: digest(requestId) -> stored {request, result} */
	receipts: Record<string, string>;
};
export const ProviderWrites = defineDoc<ProviderWriteData>({
	kind: "v2.provider-write-receipts",
	version: 1,
	scope: "session",
	initial: () => ({ receipts: {} }),
	checkpointWhen: () => true,
});
export function writeKey(requestId: string): string {
	return digest(requestId);
}
/** Replay-safe write receipts. Same request, same input replays the recorded
 * outcome; a reused requestId with different input is refused. */
export function replayWrite(
	doc: ProviderWriteData,
	key: string,
	request: string,
): { result: unknown } | null {
	const raw = doc.receipts[key];
	if (!raw) return null;
	const receipt = stored<{ request: string; result: unknown }>(raw);
	if (receipt.request !== request)
		throw new Error("Write request ID reused for different input");
	return { result: receipt.result };
}
export function recordWrite(
	doc: ProviderWriteData,
	key: string,
	request: string,
	result: unknown,
): void {
	doc.receipts[key] = JSON.stringify({ request, result });
}
