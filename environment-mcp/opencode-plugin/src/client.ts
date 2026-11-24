import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UiCapabilityApi } from "../../src/ui/capability-api.ts";
import {
	createHttpUiCapabilityApi,
	loopbackBaseUrl,
} from "../../src/ui/http-capability-api.ts";

const DEFAULT_URL = "http://127.0.0.1:38471";
const DEFAULT_TOKEN_FILE = join(
	homedir(),
	".config/environment-mcp/client-token",
);

function optionText(
	options: Readonly<Record<string, unknown>> | undefined,
	key: string,
): string | undefined {
	const value = options?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	return "environment-request-failed";
}

function resolveConnection(options?: Readonly<Record<string, unknown>>) {
	const url =
		optionText(options, "url") ??
		process.env.ENVIRONMENT_MCP_URL ??
		DEFAULT_URL;
	const tokenFile =
		optionText(options, "tokenFile") ??
		process.env.ENVIRONMENT_MCP_TOKEN_FILE ??
		DEFAULT_TOKEN_FILE;
	let token: string;
	try {
		token = readFileSync(tokenFile, "utf8").trim();
	} catch {
		throw new Error(`client token unavailable: ${tokenFile}`);
	}
	if (!token) throw new Error(`client token is empty: ${tokenFile}`);
	return { url, token, tokenFile };
}

/** Reads the same loopback capability endpoint the standalone OpenTUI uses.
 * The plugin never imports MCP registration, listeners or service internals. */
export function createEnvironmentApi(
	options?: Readonly<Record<string, unknown>>,
): UiCapabilityApi {
	const connection = resolveConnection(options);
	try {
		return createHttpUiCapabilityApi({
			url: connection.url,
			token: connection.token,
		});
	} catch (error) {
		throw new Error(
			`client token invalid (${connection.tokenFile}): ${errorMessage(error)}`,
		);
	}
}

export type EnvironmentStreamEvent = {
	seq: number;
	type: string;
	at: number;
	repository?: string;
	operationId?: string;
};

export type SseFrame = {
	id?: string;
	data?: string;
};

/** Consume complete SSE frames and return the incomplete remainder. Heartbeat
 * comments still advance the buffer. */
export function drainSseFrames(
	buffer: string,
	onFrame: (frame: SseFrame) => void,
): string {
	let rest = buffer;
	for (;;) {
		const boundary = rest.indexOf("\n\n");
		if (boundary < 0) return rest;
		const raw = rest.slice(0, boundary);
		rest = rest.slice(boundary + 2);
		let id = "";
		let data = "";
		for (const line of raw.split("\n")) {
			if (line.startsWith("id: ")) id = line.slice(4).trim();
			else if (line.startsWith("data: "))
				data += `${data ? "\n" : ""}${line.slice(6)}`;
		}
		if (id || data)
			onFrame({
				...(id ? { id } : {}),
				...(data ? { data } : {}),
			});
	}
}

/** Authenticated SSE invalidation stream. Reconnects with the last event id so
 * a short interruption is replayed from the server's bounded ring. */
export function createEnvironmentEvents(
	options?: Readonly<Record<string, unknown>>,
) {
	const { url, token } = resolveConnection(options);
	const base = loopbackBaseUrl(url);
	return {
		async subscribe(
			signal: AbortSignal,
			onEvent: (event: EnvironmentStreamEvent) => void,
		) {
			let lastId = "";
			let backoff = 500;
			while (!signal.aborted) {
				try {
					const response = await fetch(`${base}/events`, {
						redirect: "error",
						signal,
						headers: {
							authorization: `Bearer ${token}`,
							accept: "text/event-stream",
							...(lastId ? { "last-event-id": lastId } : {}),
						},
					});
					if (response.status !== 200 || !response.body)
						throw new Error(`event-stream-${response.status}`);
					backoff = 500;
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					while (!signal.aborted) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer = drainSseFrames(
							buffer +
								decoder
									.decode(value, { stream: true })
									.replaceAll("\r\n", "\n"),
							(frame) => {
								if (frame.id) lastId = frame.id;
								if (!frame.data) return;
								try {
									const event = JSON.parse(
										frame.data,
									) as EnvironmentStreamEvent;
									if (
										typeof event.type === "string" &&
										typeof event.seq === "number"
									)
										onEvent(event);
								} catch {
									// Ignore malformed frames and keep the stream alive.
								}
							},
						);
					}
				} catch {
					if (signal.aborted) return;
				}
				if (signal.aborted) return;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, backoff);
					signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				});
				backoff = Math.min(backoff * 2, 10_000);
			}
		},
	};
}

/** Keeps the page controller shape intact when setup fails before an API
 * exists, so the error state and retry path are the same as a network error. */
export function failingApi(message: string): UiCapabilityApi {
	return {
		async list() {
			throw new Error(message);
		},
		async invoke() {
			throw new Error(message);
		},
	};
}
