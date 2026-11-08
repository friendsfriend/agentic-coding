import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { defineDoc } from "@earendil-works/pi-durable";
import { digest, text } from "./config.ts";
import type {
	StandaloneInventory,
	StandaloneMode,
	StandaloneSession,
} from "./protocol/standalone.ts";
import type { Runtime } from "./runtime.ts";
import { StandalonePiStore } from "./standalone-pi-store.ts";

const Sessions = defineDoc<{ records: Record<string, string> }>({
	kind: "v2.standalone",
	version: 1,
	scope: "session",
	initial: () => ({ records: {} }),
	checkpointWhen: () => true,
});
type Retained = StandaloneSession & {
	backend: string | null;
	context: string;
	attempts: Record<string, string>;
};
/** Standalone conversations never become durable tasks/conversations or acquire task tools. */
export class Standalone {
	private live = new Map<
		string,
		{ abort: () => Promise<void>; partial?: string; messageId?: string }
	>();
	private url: URL | null = null;
	private token = process.env.AGENTIC_CODING_V2_OPENCODE_TOKEN ?? "";
	constructor(private app: Runtime) {
		const source = process.env.AGENTIC_CODING_V2_OPENCODE_URL;
		if (source) {
			const url = new URL(source);
			if (
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				(url.protocol !== "https:" &&
					!(
						url.protocol === "http:" &&
						["127.0.0.1", "[::1]"].includes(url.hostname)
					))
			)
				throw new Error(
					"OpenCode requires explicit HTTPS or numeric loopback URL without credentials/query/fragment",
				);
			this.url = url;
		}
	}
	private async record(id: string): Promise<Retained> {
		const stored = (await this.app.harness.snapshot(Sessions, context))
			?.records[id];
		if (!stored)
			throw new Error("Standalone session is not owned by this host");
		return JSON.parse(stored);
	}
	private async save(value: Retained) {
		await this.app.home.commit(async (tx) => {
			const doc = await tx.doc(Sessions);
			if (
				!Object.hasOwn(doc.records, value.id) &&
				Object.keys(doc.records).length >= 64
			)
				throw new Error("Standalone catalog full");
			doc.records[value.id] = JSON.stringify(value);
		}, context);
	}
	private public(value: Retained, selected: boolean): StandaloneSession {
		return {
			id: value.id,
			mode: value.mode,
			title: value.title,
			repository: value.repository,
			profile: value.profile,
			revision: value.revision,
			status:
				value.status === "busy" && !this.live.has(value.id)
					? "uncertain"
					: value.status,
			messages: selected ? value.messages : [],
			truncated: value.truncated,
			partial:
				selected && value.status === "busy"
					? (this.live.get(value.id)?.partial ?? null)
					: null,
		};
	}
	async read(id?: string): Promise<StandaloneInventory> {
		const records = id
			? [await this.record(id)]
			: Object.values(
					(await this.app.harness.snapshot(Sessions, context))?.records ?? {},
				).map((value) => JSON.parse(value) as Retained);
		return {
			sessions: records.map((value) => this.public(value, !!id)),
			piAvailable:
				this.app.models instanceof ModelRuntime && process.platform !== "win32",
			opencodeAvailable: this.url !== null,
			scope:
				"Native standalone chat. Pi: no tools, extensions, skills or project context discovery. OpenCode: explicitly trusted configured native service, created with deny-all permissions; global plugins/runtime policy are not sandboxed here. Neither receives durable task/environment authority. No legacy or durable-session relabeling.",
		};
	}
	private profile(id: string) {
		const profile = this.app.config.profiles.find(
			(profile) => profile.id === id,
		);
		if (!profile) throw new Error("Unknown configured profile");
		return profile;
	}
	private async request(
		value: Retained,
		method: string,
		route: string,
		body?: unknown,
	) {
		if (!this.url) throw new Error("OpenCode URL is not configured");
		const url = new URL(
			`${this.url.pathname.replace(/\/$/, "")}${route}`,
			this.url,
		);
		url.searchParams.set("directory", value.repository);
		const response = await fetch(url, {
			method,
			redirect: "error",
			signal: AbortSignal.timeout(60000),
			headers: {
				"Content-Type": "application/json",
				...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const reader = response.body?.getReader();
		let used = 0;
		const chunks: Uint8Array[] = [];
		try {
			if (reader)
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					used += chunk.value.length;
					if (used > 384000)
						throw new Error("OpenCode response exceeds native bound");
					chunks.push(chunk.value);
				}
		} finally {
			await reader?.cancel();
		}
		if (!response.ok)
			throw new Error(
				"Native OpenCode operation refused or uncertain; no resend",
			);
		let output = Buffer.concat(chunks).toString("utf8");
		if (this.token) output = output.replaceAll(this.token, "[redacted]");
		if (!output) return null;
		return JSON.parse(
			JSON.stringify(JSON.parse(output), (_key, value) =>
				typeof value === "string" && this.token
					? value.replaceAll(this.token, "[redacted]")
					: value,
			),
		);
	}
	async create(
		mode: StandaloneMode,
		profile: string,
		repository: string,
		title: string,
	) {
		this.profile(profile);
		if (
			!this.app.config.repositories.includes(repository) ||
			(mode === "pi" ? !(this.app.models instanceof ModelRuntime) : !this.url)
		)
			throw new Error("Standalone backend/repository unavailable");
		const inventory = await this.read();
		if (inventory.sessions.length >= 64)
			throw new Error("Standalone catalog full; no automatic pruning");
		const value: Retained = {
			id: randomUUID(),
			mode,
			profile,
			repository,
			title: text(title, "standalone title", 256),
			status: "uncertain",
			revision: 1,
			messages: [],
			truncated: false,
			backend: null,
			context: "[]",
			partial: null,
			attempts: {},
		};
		await this.save(value);
		if (mode === "pi") {
			const retained = new StandalonePiStore(this.app.config.stateDir).create(
				value.id,
				repository,
			);
			value.backend = retained.file;
			value.context = retained.digest;
		}
		if (mode === "opencode") {
			const result = await this.request(value, "POST", "/session", {
				title: value.title,
				permission: [{ permission: "*", pattern: "*", action: "deny" }],
			});
			if (
				!result ||
				typeof result.id !== "string" ||
				!/^ses_[a-zA-Z0-9]+$/.test(result.id)
			)
				throw new Error(
					"OpenCode creation acknowledgement unavailable; no adoption/retry",
				);
			value.backend = result.id;
		}
		value.status = "ready";
		value.revision++;
		await this.save(value);
		return this.public(value, true);
	}
	async send(
		id: string,
		revision: number,
		content: string,
		requestId: string,
		compact = false,
	) {
		content = text(content, "standalone message", 64000);
		requestId = text(requestId, "standalone request identity", 128);
		const value = await this.record(id);
		if (
			compact &&
			value.mode === "opencode" &&
			content !== "Native context compaction"
		)
			throw new Error(
				"OpenCode native summarize does not support custom instructions",
			);
		if (
			value.status !== "ready" ||
			value.revision !== revision ||
			this.live.has(id) ||
			value.attempts[requestId] ||
			Object.keys(value.attempts).length >= 256
		)
			throw new Error(
				"Standalone busy/closed/uncertain or request already consumed; no replay",
			);
		const profile = this.profile(value.profile);
		value.messages.push({ role: "user", content });
		while (
			value.messages.length > 100 ||
			JSON.stringify(value.messages).length > 96000
		) {
			value.messages.shift();
			value.truncated = true;
		}
		value.attempts[requestId] = digest(content);
		value.status = "busy";
		value.revision++;
		// Durable uncertain-before-dispatch receipt. Never reconstruct or resend interrupted attempts.
		await this.app.home.commit(async (tx) => {
			const catalog = await tx.doc(Sessions),
				current: Retained = JSON.parse(catalog.records[id] ?? "null");
			if (
				current?.status !== "ready" ||
				current.revision !== value.revision - 1
			)
				throw new Error("Standalone changed before admission");
			catalog.records[id] = JSON.stringify(value);
		}, context);
		let dispose: (() => void) | undefined;
		this.live.set(id, {
			abort: async () => {
				throw new Error(
					"Standalone dispatch preparing; inspect status before abort",
				);
			},
		});
		try {
			let answer: string;
			if (value.mode === "pi") {
				if (!(this.app.models instanceof ModelRuntime))
					throw new Error("Native Pi ModelRuntime unavailable");
				const model = this.app.models.getModel(
					profile.provider,
					profile.modelId,
				);
				if (!model) throw new Error("Configured model unavailable");
				if (!value.backend) throw new Error("Native Pi creation uncertain");
				const store = new StandalonePiStore(this.app.config.stateDir);
				const manager = store.open(value.id, value.backend, value.context);
				const settings = SettingsManager.inMemory({
					compaction: { enabled: false },
					retry: { enabled: false },
				});
				const loader = new DefaultResourceLoader({
					cwd: value.repository,
					agentDir: this.app.config.stateDir,
					settingsManager: settings,
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				});
				// Supplied empty loader is not reloaded/discovered. Explicit model/runtime/settings/session suppress SDK defaults.
				const { session } = await createAgentSession({
					cwd: value.repository,
					agentDir: this.app.config.stateDir,
					modelRuntime: this.app.models,
					model,
					thinkingLevel: profile.thinking,
					noTools: "all",
					sessionManager: manager,
					settingsManager: settings,
					resourceLoader: loader,
				});
				dispose = () => session.dispose();
				this.live.set(id, { abort: () => session.abort() });
				session.subscribe((event) => {
					if (
						event.type === "message_update" &&
						event.assistantMessageEvent.type === "text_delta"
					) {
						const live = this.live.get(id);
						if (live)
							live.partial = (
								(live.partial ?? "") + event.assistantMessageEvent.delta
							).slice(0, 64000);
					}
				});
				const compaction = compact
					? await session.compact(
							content === "Native context compaction" ? undefined : content,
						)
					: null;
				if (!compact)
					await session.prompt(content, { expandPromptTemplates: false });
				const messages = session.state.messages.filter(
					(message) => message.role === "user" || message.role === "assistant",
				);
				value.context = store.inspect(value.id, value.backend);
				const last = [...messages]
					.reverse()
					.find((message) => message.role === "assistant");
				answer = compaction
					? compaction.summary
					: last && Array.isArray(last.content)
						? last.content
								.filter((part) => part.type === "text")
								.map((part) => (part.type === "text" ? part.text : ""))
								.join("\n")
						: "";
			} else {
				if (!value.backend)
					throw new Error("OpenCode session creation uncertain");
				this.live.set(id, {
					abort: async () => {
						await this.request(
							value,
							"POST",
							`/session/${value.backend}/abort`,
						);
					},
				});
				if (compact) {
					const result = await this.request(
						value,
						"POST",
						`/session/${value.backend}/summarize`,
						{
							providerID: profile.provider,
							modelID: profile.modelId,
							auto: false,
						},
					);
					if (result !== true)
						throw new Error(
							"OpenCode summarization acknowledgement unavailable",
						);
					answer =
						"Native context summarization acknowledged; retained display history was not rewritten.";
				} else {
					const result = await this.request(
						value,
						"POST",
						`/session/${value.backend}/message`,
						{
							messageID: `msg_${randomUUID().replaceAll("-", "")}`,
							model: { providerID: profile.provider, modelID: profile.modelId },
							parts: [{ type: "text", text: content }],
						},
					);
					if (!Array.isArray(result?.parts))
						throw new Error("OpenCode response acknowledgement incomplete");
					answer = result.parts
						.filter((part: { type?: string }) => part.type === "text")
						.map((part: { text?: string }) =>
							typeof part.text === "string" ? part.text : "",
						)
						.join("\n");
				}
			}
			if (answer.length > 64000) value.truncated = true;
			value.messages.push({
				role: "assistant",
				content: answer.slice(0, 64000),
			});
			while (
				value.messages.length > 100 ||
				JSON.stringify(value.messages).length > 96000
			) {
				value.messages.shift();
				value.truncated = true;
			}
			value.status = "ready";
			value.revision++;
			await this.save(value);
			return this.public(value, true);
		} catch {
			value.status = "uncertain";
			value.revision++;
			await this.save(value);
			throw new Error(
				"Standalone attempt uncertain; inspect retained status. No automatic resend or context adoption.",
			);
		} finally {
			this.live.delete(id);
			dispose?.();
		}
	}
	async configure(id: string, revision: number, profile: string) {
		this.profile(profile);
		await this.app.home.commit(async (tx) => {
			const doc = await tx.doc(Sessions),
				raw = doc.records[id];
			if (!raw) throw new Error("Standalone unavailable");
			const value: Retained = JSON.parse(raw);
			if (
				value.revision !== revision ||
				value.status !== "ready" ||
				this.live.has(id)
			)
				throw new Error("Standalone stale or not ready");
			value.profile = profile;
			value.revision++;
			doc.records[id] = JSON.stringify(value);
		}, context);
	}
	async retire(id: string, revision: number) {
		await this.app.home.commit(async (tx) => {
			const doc = await tx.doc(Sessions),
				raw = doc.records[id];
			if (!raw) throw new Error("Standalone unavailable");
			const value: Retained = JSON.parse(raw);
			if (
				value.revision !== revision ||
				value.status === "closed" ||
				this.live.has(id)
			)
				throw new Error("Standalone stale or live");
			value.status = "closed";
			value.revision++;
			doc.records[id] = JSON.stringify(value);
		}, context);
	}
	async abort(id: string) {
		await this.record(id);
		const live = this.live.get(id);
		if (!live)
			throw new Error(
				"No host-owned live standalone attempt; interrupted sessions are not adopted",
			);
		await live.abort();
	}
	async close() {
		if (!this.live.size) return;
		await Promise.race([
			Bun.sleep(2000),
			Promise.allSettled([...this.live.values()].map((value) => value.abort())),
		]);
	}
}
