import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { type Config, digest } from "../config.ts";
import { decode, type TaskInfo } from "../state.ts";
import type { LiveEnvironmentAuthority } from "./authority.ts";
import {
	type EndpointCa,
	loadEndpointCa,
	prepareEndpointCa,
} from "./endpoint-ca.ts";
import { readOnlyQuery } from "./query.ts";
import {
	type QueryConnection,
	type QueryInput,
	queryInput,
} from "./query-config.ts";
import { ShellProcess } from "./shell.ts";
import { type EnvironmentRun, EnvironmentState } from "./state.ts";

type QueryRequest = {
	input: QueryInput;
	run: string;
	app: string;
	connection: QueryConnection;
	ca?: EndpointCa;
};
export type QueryReceipt = {
	owner: number;
	inputDigest: string;
	approved: QueryRequest;
	issuedAt: number;
	state: "issued" | "completed";
	result?: Awaited<ReturnType<typeof readOnlyQuery>> & {
		run: string;
		infra: string;
		app: string;
		observedAt: number;
	};
};
const inputDigest = (input: QueryInput) => digest(JSON.stringify(input));
function replay(receipt: QueryReceipt, owner: number, input: QueryInput) {
	if (receipt.owner !== owner || receipt.inputDigest !== inputDigest(input))
		throw new Error("SQL issuance identity mismatch");
	if (receipt.state !== "completed" || !receipt.result)
		throw new Error(
			"SQL issuance is uncertain; native replay cannot resend or adopt database authority",
		);
	return {
		...receipt.result,
		replayed: true,
		authority:
			"Recorded completed SQL diagnostic; no new query, connection or live authority",
	};
}
/** Server-private live lease checks remain mandatory independently of native tool approval. */
export class DatabaseDiagnostics {
	constructor(
		private config: Config,
		private authority: LiveEnvironmentAuthority,
	) {}
	private async held(owner: TaskInfo, infra: string, signal?: AbortSignal) {
		this.authority.check(owner.id, signal);
		if (owner.policy !== "workspace-write")
			throw new Error(
				"SQL diagnostics require a workspace-write native task and separate approval",
			);
		const runs = (await this.authority.records()).filter(
				(run) =>
					run.owner === owner.id && run.plan.workspace === owner.workspace,
			),
			matching = runs.filter(
				(run) =>
					run.plan.app === infra &&
					run.plan.projectKind === "infrastructure" &&
					run.state === "running" &&
					run.ready === true,
			),
			run = matching.length === 1 ? matching[0] : undefined,
			process = run ? this.authority.live.get(run.id) : undefined;
		if (!run || !(process instanceof ShellProcess) || !run.plan.queryConnection)
			throw new Error(
				"SQL requires this task's live ready shell infrastructure with a declared query connection; receipts grant no authority",
			);
		const members = runs.filter((item) => item.batch === run.batch),
			alive = (item: EnvironmentRun) => {
				const live = this.authority.live.get(item.id);
				return (
					item.state === "running" &&
					live &&
					!live.outcome &&
					!live.cleanupFailed
				);
			};
		const requires = (app: EnvironmentRun) => {
			const pending = [...(app.plan.requires ?? [])],
				seen = new Set<string>();
			while (pending.length) {
				const next = pending.pop();
				if (!next || seen.has(next)) continue;
				if (next === infra) return true;
				seen.add(next);
				pending.push(
					...(members.find((item) => item.plan.app === next)?.plan.requires ??
						[]),
				);
			}
			return false;
		};
		const app = members.find(
			(item) => item.plan.projectKind === "app" && requires(item),
		);
		if (!app || !members.every(alive))
			throw new Error(
				"SQL requires a live held application whose immutable dependency plan requires this infrastructure",
			);
		this.authority.check(owner.id, signal, run.batch);
		return {
			run,
			process,
			app,
			members: members.map((item) => ({
				run: item,
				process: this.authority.live.get(item.id),
			})),
		};
	}
	async prepare(
		owner: TaskInfo,
		input: QueryInput,
		signal?: AbortSignal,
	): Promise<QueryRequest> {
		queryInput(input.infra, input.sql, input.limit, input.schema);
		const { run, app } = await this.held(owner, input.infra, signal),
			connection = run.plan.queryConnection;
		if (!connection) throw new Error("Query connection is unavailable");
		return {
			input,
			run: run.id,
			app: app.plan.app,
			connection,
			...(connection.caRef
				? { ca: prepareEndpointCa(this.config.configDir, connection.caRef) }
				: {}),
		};
	}
	async receipt(
		owner: TaskInfo,
		id: string,
		input: QueryInput,
		signal?: AbortSignal,
	) {
		this.authority.check(owner.id, signal);
		if (owner.policy !== "workspace-write")
			throw new Error("SQL receipt requires its workspace-write native owner");
		const raw = await this.authority.store().commit(async (tx) => {
			const task = await tx.task(owner.id as TaskId);
			if (!task || task.abortRequested || task.state.status === "terminal")
				throw new Error("SQL native owner has ended");
			return (await tx.doc(EnvironmentState)).queryOperations?.[id];
		}, background);
		this.authority.check(owner.id, signal);
		return raw ? replay(decode<QueryReceipt>(raw), owner.id, input) : null;
	}
	async request(
		owner: TaskInfo,
		approved: QueryRequest,
		id: string,
		signal?: AbortSignal,
	) {
		const held = await this.held(owner, approved.input.infra, signal),
			{ run, process, app } = held;
		if (
			run.id !== approved.run ||
			app.plan.app !== approved.app ||
			JSON.stringify(run.plan.queryConnection) !==
				JSON.stringify(approved.connection) ||
			approved.connection.caRef !== approved.ca?.file
		)
			throw new Error(
				"Approved SQL connection no longer matches the held infrastructure",
			);
		const credentials = process.queryCredentials();
		if (!credentials) throw new Error("Held query credentials are unavailable");
		const ca = approved.ca
			? loadEndpointCa(this.config.configDir, approved.ca)
			: undefined;
		const operation = (async () => {
			const deadline = AbortSignal.timeout(10000),
				bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
			const check = () => {
				this.authority.check(owner.id, bounded, run.batch);
				for (const member of held.members)
					if (
						!member.process ||
						this.authority.live.get(member.run.id) !== member.process ||
						member.process.outcome ||
						member.process.cleanupFailed
					)
						throw new Error(
							"SQL dependency batch is closing; no result accepted",
						);
			};
			const previous = await this.authority.store().commit(async (tx) => {
				const task = await tx.task(owner.id as TaskId);
				check();
				if (!task || task.abortRequested || task.state.status === "terminal")
					throw new Error("SQL native owner has ended");
				const doc = await tx.doc(EnvironmentState);
				check();
				doc.queryOperations ??= {};
				const raw = doc.queryOperations[id];
				if (raw) return decode<QueryReceipt>(raw);
				doc.queryOperations[id] = JSON.stringify({
					owner: owner.id,
					inputDigest: inputDigest(approved.input),
					approved,
					issuedAt: Date.now(),
					state: "issued",
				} satisfies QueryReceipt);
				return null;
			}, background);
			if (previous) return replay(previous, owner.id, approved.input);
			check();
			const result = await readOnlyQuery(
					approved.connection,
					credentials,
					approved.input,
					ca,
					bounded,
					check,
					process.redact,
				),
				current = await this.held(owner, approved.input.infra, bounded);
			check();
			if (current.run.id !== run.id || current.process !== process)
				throw new Error("SQL ownership changed; response discarded");
			const response = {
				...result,
				run: run.id,
				infra: approved.input.infra,
				app: app.plan.app,
				observedAt: Date.now(),
			};
			await this.authority.store().commit(async (tx) => {
				const task = await tx.task(owner.id as TaskId);
				check();
				if (!task || task.abortRequested || task.state.status === "terminal")
					throw new Error("SQL native owner ended; response discarded");
				const doc = await tx.doc(EnvironmentState);
				check();
				const raw = doc.queryOperations?.[id];
				if (!raw) throw new Error("SQL issuance receipt is missing");
				const receipt = decode<QueryReceipt>(raw);
				if (
					receipt.owner !== owner.id ||
					receipt.inputDigest !== inputDigest(approved.input) ||
					receipt.state !== "issued" ||
					JSON.stringify(receipt.approved) !== JSON.stringify(approved)
				)
					throw new Error("SQL issuance changed; response discarded");
				if (doc.queryOperations)
					doc.queryOperations[id] = JSON.stringify({
						...receipt,
						state: "completed",
						result: response,
					});
			}, background);
			return { ...response, replayed: false };
		})();
		this.authority.pending.set(operation, {
			owner: owner.id,
			batch: run.batch,
		});
		try {
			return await operation;
		} finally {
			this.authority.pending.delete(operation);
		}
	}
}
