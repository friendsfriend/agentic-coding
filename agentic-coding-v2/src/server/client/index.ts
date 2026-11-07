import { randomUUID } from "node:crypto";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import {
	type Frame,
	maxFrameBytes,
	methods,
	request,
} from "../../protocol/index.ts";
import type { Runtime } from "../../runtime.ts";
import { dispatch } from "./handlers/index.ts";
import { clientSession, clientSnapshot } from "./handlers/sessions.ts";
import { type SessionWatch, watchSession } from "./watch.ts";

export type Connection = {
	id: string;
	subscribed: boolean;
	pending: Set<string>;
	chain: Promise<void>;
	sequence: number;
	watchId: string | null;
	watch: SessionWatch | null;
};
/** Sole client-protocol ingress. No arbitrary route/method forwarding. */
export function clientGateway(app: Runtime) {
	const sockets = new Set<ServerWebSocket<Connection>>();
	const closing = new Set<Promise<void>>();
	function retire(socket: ServerWebSocket<Connection>) {
		if (!sockets.delete(socket)) return;
		socket.data.watchId = null;
		const watch = socket.data.watch;
		socket.data.watch = null;
		// Setup in flight notices the removed socket and releases its own watch.
		const end = Promise.all([watch?.stop(), socket.data.chain]).then(() => {});
		closing.add(end);
		void end.finally(() => closing.delete(end));
	}
	let stopped = false,
		polling = false;
	function send(socket: ServerWebSocket<Connection>, frame: Frame) {
		if (stopped || !sockets.has(socket)) return;
		const bytes = JSON.stringify(frame);
		if (
			Buffer.byteLength(bytes) > maxFrameBytes ||
			socket.getBufferedAmount() > maxFrameBytes
		) {
			socket.close(1009, "Client frame budget exceeded; resynchronize");
			return;
		}
		socket.send(bytes);
	}
	let timer: ReturnType<typeof setInterval> | null = null;
	const poll = async () => {
		if (
			stopped ||
			polling ||
			![...sockets].some((socket) => socket.data.subscribed)
		)
			return;
		polling = true;
		try {
			const value = await clientSnapshot(app);
			if (!stopped)
				for (const socket of sockets)
					if (socket.data.subscribed)
						send(socket, {
							version: 1,
							type: "state",
							sequence: ++socket.data.sequence,
							value,
						});
		} catch {
			for (const socket of sockets)
				if (socket.data.subscribed)
					send(socket, {
						version: 1,
						type: "error",
						id: null,
						code: "unavailable",
						message: "State refresh unavailable",
					});
		} finally {
			polling = false;
		}
	};
	const websocket: WebSocketHandler<Connection> = {
		maxPayloadLength: maxFrameBytes,
		open(socket) {
			if (sockets.size + closing.size >= 8 || stopped) {
				socket.close(1013, "Client capacity reached");
				return;
			}
			sockets.add(socket);
			if (!timer) timer = setInterval(poll, 1000);
			send(socket, {
				version: 1,
				type: "hello",
				connection: socket.data.id,
				methods,
			});
		},
		message(socket, bytes) {
			let command: ReturnType<typeof request>;
			try {
				command = request(
					JSON.parse(typeof bytes === "string" ? bytes : bytes.toString()),
				);
			} catch {
				send(socket, {
					version: 1,
					type: "error",
					id: null,
					code: "invalid-request",
					message: "Invalid client request",
				});
				return;
			}
			const value = command;
			if (socket.data.pending.has(value.id) || socket.data.pending.size >= 16) {
				send(socket, {
					version: 1,
					type: "error",
					id: value.id,
					code: "invalid-request",
					message: "Duplicate in-flight request or connection capacity reached",
				});
				return;
			}
			socket.data.pending.add(value.id);
			socket.data.chain = socket.data.chain.then(async () => {
				if (stopped || !sockets.has(socket)) return;
				try {
					let result: unknown;
					if (value.method === "session.watch") {
						const { id, watchId } = value.input;
						if (
							Object.keys(value.input).some(
								(key) => key !== "id" && key !== "watchId",
							) ||
							!(id === null || (Number.isSafeInteger(id) && Number(id) >= 0)) ||
							typeof watchId !== "string" ||
							!/^[a-zA-Z0-9:_-]{1,128}$/.test(watchId)
						)
							throw new Error("Invalid session watch");
						if (id !== null) await clientSession(app, Number(id), false);
						if (stopped || !sockets.has(socket)) return;
						socket.data.watchId = watchId;
						const previous = socket.data.watch;
						socket.data.watch = null;
						await previous?.stop();
						if (id !== null && !stopped && sockets.has(socket)) {
							const current = () =>
								!stopped &&
								sockets.has(socket) &&
								socket.data.watchId === watchId;
							const watch = await watchSession(
								app,
								Number(id),
								(value) => {
									if (current())
										send(socket, {
											version: 1,
											type: "session",
											sequence: ++socket.data.sequence,
											watchId,
											value,
										});
								},
								() => {
									if (current())
										send(socket, {
											version: 1,
											type: "session-unavailable",
											sequence: ++socket.data.sequence,
											watchId,
											message:
												"Native transcript observation unavailable; resynchronize",
										});
								},
							);
							if (current()) socket.data.watch = watch;
							else await watch.stop();
						}
						result = { id, watchId };
					} else result = await dispatch(app, value);
					if (value.method === "state.subscribe") {
						socket.data.subscribed = true;
						send(socket, {
							version: 1,
							type: "response",
							id: value.id,
							value: { subscribed: true },
						});
					} else
						send(socket, {
							version: 1,
							type: "response",
							id: value.id,
							value: result,
						});
				} catch {
					send(socket, {
						version: 1,
						type: "error",
						id: value.id,
						code: "refused",
						message:
							"Native operation refused; refresh state and inspect the requested operation",
					});
				} finally {
					socket.data.pending.delete(value.id);
				}
			});
		},
		close(socket) {
			retire(socket);
			if (!sockets.size && timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
	return {
		websocket,
		connection: (): Connection => ({
			id: randomUUID(),
			subscribed: false,
			pending: new Set(),
			chain: Promise.resolve(),
			sequence: 0,
			watchId: null,
			watch: null,
		}),
		stop: async () => {
			stopped = true;
			if (timer) clearInterval(timer);
			const active = [...sockets];
			for (const socket of active) {
				socket.close(1001, "Host stopping");
				retire(socket);
			}
			await Promise.all([...closing]);
		},
	};
}
