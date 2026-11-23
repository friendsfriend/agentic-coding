import * as z from "zod/v4";
import {
	type OperationRecord,
	operationRecordSchema,
} from "../domain/operation.ts";
import { loopbackBaseUrl } from "../transports/http/loopback-url.ts";

const summarySchema = z.strictObject({
	id: z.uuid(),
	scope: z.uuid(),
	state: z.enum([
		"awaiting-approval",
		"approved",
		"rejected",
		"issued",
		"completed",
		"interrupted",
	]),
	revision: z.number().int().min(1),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	inspectionRequired: z.boolean(),
	createdAt: z.number().int(),
});
const listSchema = z.strictObject({
	operations: z.array(summarySchema).max(20),
	total: z.number().int().min(0),
	nextOffset: z.number().int().min(0).nullable(),
});
export type OperatorOperationSummary = z.output<typeof summarySchema>;
export type OperatorOperation = OperationRecord;
export type OperatorList = z.output<typeof listSchema>;
export type OperatorDecisionInput = {
	requestId: string;
	digest: string;
	revision: number;
	decision: "approved" | "rejected";
};
export type OperatorAcknowledgementInput = {
	requestId: string;
	digest: string;
	revision: number;
};
export type OperatorApi = {
	list(
		offset?: number,
		limit?: number,
		options?: { signal?: AbortSignal },
	): Promise<OperatorList>;
	inspect(
		id: string,
		options?: { signal?: AbortSignal },
	): Promise<OperatorOperation>;
	decide(
		id: string,
		input: OperatorDecisionInput,
		options?: { signal?: AbortSignal },
	): Promise<OperatorOperation>;
	acknowledge(
		id: string,
		input: OperatorAcknowledgementInput,
		options?: { signal?: AbortSignal },
	): Promise<OperatorOperation>;
};

export class OperatorClientError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

/** Human-only HTTP client. It has no MCP or agent-capability path. */
export function createHttpOperatorApi(options: {
	url: string;
	token: string;
	fetch?: typeof fetch;
}): OperatorApi {
	const base = loopbackBaseUrl(options.url);
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(options.token))
		throw new Error("Invalid operator token");
	const request = async (
		route: string,
		signal: AbortSignal | undefined,
		init: RequestInit = {},
	) => {
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), 30_000);
		let response: Response;
		try {
			response = await (options.fetch ?? fetch)(`${base}${route}`, {
				...init,
				redirect: "error",
				signal: signal
					? AbortSignal.any([signal, timeout.signal])
					: timeout.signal,
				headers: {
					authorization: `Bearer ${options.token}`,
					...init.headers,
				},
			});
		} finally {
			clearTimeout(timer);
		}
		const text = await response.text();
		if (text.length > 256 * 1024)
			throw new OperatorClientError("response-too-large");
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new OperatorClientError("invalid-response");
		}
		if (!response.ok) {
			const code =
				typeof body === "object" && body !== null && "error" in body
					? (body as { error?: unknown }).error
					: undefined;
			throw new OperatorClientError(
				typeof code === "string" ? code : "request-failed",
			);
		}
		return body;
	};
	return {
		async list(offset = 0, limit = 20, requestOptions) {
			if (
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 20
			)
				throw new OperatorClientError("invalid-query");
			return listSchema.parse(
				await request(
					`/operator/operations?offset=${offset}&limit=${limit}`,
					requestOptions?.signal,
				),
			);
		},
		async inspect(id, requestOptions) {
			return operationRecordSchema.parse(
				await request(
					`/operator/operations/${encodeURIComponent(id)}`,
					requestOptions?.signal,
				),
			);
		},
		async decide(id, input, requestOptions) {
			return operationRecordSchema.parse(
				await request(
					`/operator/operations/${encodeURIComponent(id)}/decision`,
					requestOptions?.signal,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(input),
					},
				),
			);
		},
		async acknowledge(id, input, requestOptions) {
			return operationRecordSchema.parse(
				await request(
					`/operator/operations/${encodeURIComponent(id)}/acknowledge`,
					requestOptions?.signal,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(input),
					},
				),
			);
		},
	};
}
