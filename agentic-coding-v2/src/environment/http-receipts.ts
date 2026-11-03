import { digest } from "../config.ts";
import type { EndpointRequest } from "./endpoint.ts";
import type { endpointRequest } from "./http.ts";
import type { HttpOptions } from "./http-options.ts";
export type HttpInput = {
	app: string;
	endpoint: string;
	path: string;
	http: HttpOptions;
};
export type HttpResult = Awaited<ReturnType<typeof endpointRequest>> & {
	run: string;
	app: string;
	endpoint: string;
	observedAt: number;
	caDigest?: string;
};
export type HttpReceipt = {
	owner: number;
	inputDigest: string;
	approved: EndpointRequest;
	issuedAt: number;
	state: "issued" | "completed";
	result?: HttpResult;
};
export const httpDigest = (input: HttpInput) => digest(JSON.stringify(input));
export function replayHttp(
	receipt: HttpReceipt,
	owner: number,
	input: HttpInput,
) {
	if (receipt.owner !== owner || receipt.inputDigest !== httpDigest(input))
		throw new Error(
			"HTTP native operation identity mismatch; no request authorized",
		);
	if (receipt.state !== "completed" || !receipt.result)
		throw new Error(
			"HTTP operation was already issued and its response is uncertain; it will not be resent. Inspect server-side effects before requesting a fresh human-approved operation",
		);
	return { ...receipt.result, replayed: true, issuedAt: receipt.issuedAt };
}
