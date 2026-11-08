import { result, frame as serverFrame } from "../../protocol/frames.ts";
import {
	clientPath,
	type Data,
	type Method,
	type Methods,
	maxFrameBytes,
	type Snapshot,
	type Transcript,
} from "../../protocol/index.ts";

import type {
	StandaloneInventory,
	StandaloneMode,
} from "../../protocol/standalone.ts";

// DOM typings hide Bun's native header-taking constructor overload.
const NativeWebSocket = WebSocket as typeof WebSocket & {
	new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

export class CommandUncertain extends Error {
	constructor() {
		super(
			"Connection lost or response timed out; command outcome is uncertain. Refresh before retrying.",
		);
	}
}
type Pending = {
	method: Method;
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};
/** Credential is passed in-process, used in a header, and never persisted. */
export class ClientConnection {
	private socket: WebSocket | null = null;
	private pending = new Map<string, Pending>();
	private listeners = new Set<() => void>();
	private reconnect: ReturnType<typeof setTimeout> | null = null;
	private closed = false;
	private attempt = 0;
	private generation = 0;
	private resynchronizingSocket = false;
	private sequence = 0;
	private desiredSession: { id: number | null; watchId: string } | null = null;
	transcript: Transcript | null = null;
	observation: "none" | "resynchronizing" | "watching" | "unavailable" = "none";
	observationError: string | null = null;
	state: Snapshot | null = null;
	private currentSnapshot = false;
	/** Cache observation only, never permission: hello alone does not refresh retained state. */
	get stateFresh() {
		return this.status === "connected" && this.currentSnapshot;
	}
	status: "connecting" | "connected" | "reconnecting" | "closed" = "connecting";
	error: string | null = null;
	methods: Method[] = [];
	constructor(private readonly endpoint: { url: string; token: string }) {
		const url = new URL(endpoint.url);
		if (
			url.protocol !== "ws:" ||
			url.hostname !== "127.0.0.1" ||
			url.pathname !== clientPath ||
			url.search ||
			url.hash ||
			url.username ||
			url.password
		)
			throw new Error("Expected the private loopback client endpoint");
	}
	onChange(listener: () => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/** Explicit read-only inventory/detail observation. No UUID adoption, mutation or replay. */
	async observeStandalone(target: {
		mode: StandaloneMode;
		id: string | null;
	}): Promise<StandaloneInventory> {
		const generation = this.generation;
		const current = () =>
			!this.closed &&
			this.status === "connected" &&
			generation === this.generation;
		if (!current())
			throw new Error("Standalone observation connection changed");
		const listing = await this.call("standalone.read", {});
		if (!current())
			throw new Error("Standalone observation connection changed");
		const ids = new Set<string>();
		for (const session of listing.sessions) {
			if (
				ids.has(session.id) ||
				!Number.isSafeInteger(session.revision) ||
				session.revision < 1
			)
				throw new Error("Ambiguous standalone observation");
			ids.add(session.id);
		}
		if (target.id === null) return listing;
		const selected = listing.sessions.find(
			(session) => session.id === target.id && session.mode === target.mode,
		);
		if (!selected)
			throw new Error(
				"Saved standalone identity belongs to another mode or is unavailable",
			);
		const detail = await this.call("standalone.read", { id: selected.id });
		if (!current())
			throw new Error("Standalone observation connection changed");
		const row = detail.sessions.length === 1 ? detail.sessions[0] : undefined;
		if (
			!row ||
			row.id !== selected.id ||
			row.mode !== target.mode ||
			row.repository !== selected.repository ||
			!Number.isSafeInteger(row.revision) ||
			row.revision < selected.revision ||
			detail.scope !== listing.scope ||
			detail.piAvailable !== listing.piAvailable ||
			detail.opencodeAvailable !== listing.opencodeAvailable
		)
			throw new Error(
				"Standalone observation source changed; read again explicitly",
			);
		return {
			...listing,
			sessions: listing.sessions.map((session) =>
				session.id === row.id ? row : session,
			),
		};
	}
	private notify() {
		for (const listener of this.listeners) listener();
	}
	/** UI selection only. Reconnect repeats this read-only watch, never commands. */
	selectSession(id: number | null) {
		if (!(id === null || (Number.isSafeInteger(id) && id >= 0)))
			throw new Error("Invalid session identity");
		if (this.desiredSession?.id === id && this.observation !== "unavailable")
			return;
		this.desiredSession = { id, watchId: crypto.randomUUID() };
		this.transcript = null;
		this.observation = id === null ? "none" : "resynchronizing";
		this.observationError = null;
		this.notify();
		void this.observeSession();
	}
	private async observeSession() {
		const target = this.desiredSession,
			generation = this.generation;
		if (!target || this.status !== "connected") return;
		this.observation = target.id === null ? "none" : "resynchronizing";
		this.observationError = null;
		this.notify();
		try {
			const ack = await this.call("session.watch", target);
			if (ack.id !== target.id || ack.watchId !== target.watchId)
				throw new Error("Invalid session watch acknowledgement");
		} catch (error) {
			if (
				generation !== this.generation ||
				this.status !== "connected" ||
				this.desiredSession?.watchId !== target.watchId
			)
				return;
			this.observation = target.id === null ? "none" : "unavailable";
			this.observationError =
				error instanceof Error
					? error.message
					: "Native observation unavailable";
			this.notify();
		}
	}
	connect() {
		if (this.closed || this.socket) return;
		const generation = ++this.generation;
		this.currentSnapshot = false;
		this.resynchronizingSocket = false;
		const socket = new NativeWebSocket(this.endpoint.url, {
			headers: { Authorization: `Bearer ${this.endpoint.token}` },
		});
		this.socket = socket;
		socket.onmessage = (event) => {
			if (
				generation !== this.generation ||
				this.closed ||
				this.resynchronizingSocket
			)
				return;
			try {
				if (
					typeof event.data !== "string" ||
					Buffer.byteLength(event.data) > maxFrameBytes
				)
					throw new Error("Invalid server frame");
				const frame = serverFrame(JSON.parse(event.data));
				if (frame.type === "hello") {
					if (this.status === "connected")
						throw new Error("Duplicate server hello");
					this.sequence = 0;
					this.methods = frame.methods;
					this.status = "connected";
					this.error = null;
					this.attempt = 0;
					if (this.desiredSession?.id !== null) void this.observeSession();
					void this.call("state.read", {})
						.then((value) => {
							if (generation === this.generation) {
								this.state = value;
								this.currentSnapshot = true;
								this.notify();
							}
						})
						.catch((error: Error) => {
							if (generation !== this.generation || this.closed) return;
							this.error = error.message;
							this.notify();
						});
					void this.call("state.subscribe", {}).catch((error: Error) => {
						if (generation !== this.generation || this.closed) return;
						this.error = error.message;
						this.notify();
					});
				} else if (this.status !== "connected") {
					throw new Error("Server frame before hello");
				} else if (frame.type === "state") {
					if (frame.sequence <= this.sequence)
						throw new Error("Out-of-order server state");
					this.sequence = frame.sequence;
					this.state = frame.value;
					this.currentSnapshot = true;
				} else if (
					frame.type === "session" ||
					frame.type === "session-unavailable"
				) {
					if (frame.sequence <= this.sequence)
						throw new Error("Out-of-order session publication");
					this.sequence = frame.sequence;
					if (frame.watchId === this.desiredSession?.watchId) {
						if (frame.type === "session") {
							if (frame.value.id !== this.desiredSession.id)
								throw new Error("Wrong native session publication");
							this.transcript = frame.value;
							this.observation = "watching";
							this.observationError = null;
						} else {
							this.observation = "unavailable";
							this.observationError = frame.message;
						}
					}
				} else if (frame.type === "response" || frame.type === "error") {
					const pending =
						frame.id === null ? undefined : this.pending.get(frame.id);
					if (pending && frame.id !== null) {
						const value =
							frame.type === "response"
								? result(pending.method, frame.value)
								: undefined;
						clearTimeout(pending.timer);
						this.pending.delete(frame.id);
						if (frame.type === "response") pending.resolve(value);
						else pending.reject(new Error(frame.message));
					} else if (frame.type === "error") this.error = frame.message;
				} else throw new Error("Unknown server frame");
				this.notify();
			} catch {
				this.error = "Invalid server protocol frame";
				socket.close(1002, "Invalid frame");
			}
		};
		socket.onclose = () => {
			if (generation !== this.generation) return;
			this.socket = null;
			this.methods = [];
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new CommandUncertain());
			}
			this.pending.clear();
			this.status = this.closed ? "closed" : "reconnecting";
			this.observation =
				this.desiredSession && this.desiredSession.id !== null
					? "resynchronizing"
					: "none";
			this.observationError =
				"Disconnected; native activity is unknown until a new snapshot arrives";
			this.notify();
			if (!this.closed)
				this.reconnect = setTimeout(
					() => {
						this.reconnect = null;
						this.connect();
					},
					Math.min(1000 * 2 ** this.attempt++, 30000),
				);
		};
		socket.onerror = () => {
			if (generation !== this.generation || this.closed) return;
			this.error = "Client connection unavailable";
			this.notify();
		};
	}
	call<M extends Method>(
		method: M,
		input: Methods[M]["input"],
	): Promise<Methods[M]["output"]> {
		const socket = this.socket;
		if (
			this.closed ||
			this.status !== "connected" ||
			!socket ||
			socket.readyState !== WebSocket.OPEN ||
			!this.methods.includes(method)
		)
			return Promise.reject(new Error("Client operation unavailable"));
		if (this.pending.size >= 16)
			return Promise.reject(new Error("Client request capacity reached"));
		const id = crypto.randomUUID();
		const bytes = JSON.stringify({ version: 1, id, method, input });
		if (Buffer.byteLength(bytes) > maxFrameBytes)
			return Promise.reject(new Error("Client request exceeds frame budget"));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new CommandUncertain());
			}, 15000);
			this.pending.set(id, {
				method,
				timer,
				resolve: (value) => resolve(value as Methods[M]["output"]),
				reject,
			});
			try {
				socket.send(bytes);
			} catch {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new CommandUncertain());
			}
		});
	}
	/** User-requested transport refresh; pending commands still become uncertain. */
	reconnectNow() {
		if (this.closed) return;
		if (this.desiredSession?.id !== null) this.observation = "resynchronizing";
		this.notify();
		if (this.socket) {
			this.resynchronizingSocket = true;
			this.status = "reconnecting";
			this.socket.close(1001, "Client resynchronizing");
			this.notify();
		} else {
			if (this.reconnect) clearTimeout(this.reconnect);
			this.reconnect = null;
			this.connect();
		}
	}
	close() {
		this.closed = true;
		this.status = "closed";
		this.observation = "none";
		if (this.reconnect) clearTimeout(this.reconnect);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new CommandUncertain());
		}
		this.pending.clear();
		this.socket?.close();
		this.notify();
	}
}
export const dataList = (value: unknown): Data[] =>
	Array.isArray(value)
		? value.filter((item): item is Data =>
				Boolean(item && typeof item === "object" && !Array.isArray(item)),
			)
		: [];
