import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { type Config, digest } from "../config.ts";
import { decode, type TaskInfo } from "../state.ts";
import type { LiveEnvironmentAuthority } from "./authority.ts";
import { ComposeProcess } from "./compose.ts";
import { ContainerProcess } from "./container.ts";
import { declaredInfrastructure } from "./dependencies.ts";
import {
	type DiagnosticSelection,
	diagnosticHistory,
} from "./diagnostic-history.ts";
import {
	type EndpointCa,
	loadEndpointCa,
	prepareEndpointCa,
} from "./endpoint-ca.ts";
import { KubernetesProcess } from "./kubernetes.ts";
import {
	referencedLifetime,
	sameApprovedPlan,
	sharedRoot,
} from "./lifetime.ts";
import { readOnlyQuery } from "./query.ts";
import {
	type QueryConnection,
	type QueryInput,
	queryInput,
} from "./query-config.ts";
import { batchApproved } from "./reference-scope.ts";
import { ShellProcess } from "./shell.ts";
import { type EnvironmentRun, EnvironmentState } from "./state.ts";

type QueryRequest = {
	input: QueryInput;
	run: string;
	app: string;
	root?: { run: string; resources: string[] };
	connection: QueryConnection;
	service?: string;
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
		service?: string;
		root?: QueryRequest["root"];
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
	/** Developer history view only: no held-lease check, connection or query.
	 * Deliberately excludes SQL text, connection settings and credential refs. */
	async history(runId: string, selection: DiagnosticSelection = {}) {
		const run = (await this.authority.records()).find(
			(item) =>
				item.id === runId &&
				item.plan.projectKind === "infrastructure" &&
				item.plan.queryConnection,
		);
		if (!run) throw new Error("Unknown database diagnostic run");
		const doc = await this.authority
			.store()
			.snapshot(EnvironmentState, background);
		return diagnosticHistory<QueryReceipt>(
			doc?.queryOperations,
			run,
			selection,
			"SQL",
			(receipt) => receipt.approved.input.infra === run.plan.app,
			(receipt) => ({
				infra: run.plan.app,
				...(receipt.approved.service
					? { service: receipt.approved.service }
					: {}),
				app: receipt.approved.app,
				...(receipt.approved.root
					? { rootRun: receipt.approved.root.run }
					: {}),
			}),
		);
	}
	private async held(
		owner: TaskInfo,
		infra: string,
		signal?: AbortSignal,
		requiringApp?: string,
	) {
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
			handle = run ? this.authority.live.get(run.id) : undefined;
		const service = run?.plan.queryService;
		const process =
			handle instanceof ComposeProcess && service
				? await handle.diagnosticService(service, signal)
				: handle;
		const connection = run?.plan.queryConnection;
		if (
			!run ||
			!(
				process instanceof ShellProcess ||
				process instanceof ContainerProcess ||
				process instanceof KubernetesProcess
			) ||
			!connection ||
			handle?.closing ||
			process.closing ||
			handle?.outcome ||
			handle?.cleanupFailed
		)
			throw new Error(
				"SQL requires this task's live ready shell, container or single-replica pod infrastructure with a declared query connection; receipts grant no authority",
			);
		if (process instanceof KubernetesProcess) {
			// Only the exact declared forward on the query port is authority, and both
			// the owned pod and that forward are re-observed for every call.
			const forward = run.plan.kubernetes?.portForwards?.find(
					(item) => item.local === connection.port,
				),
				observed = await process.diagnostic(signal);
			if (
				!forward ||
				observed.status.owned !== true ||
				observed.status.state !== "running" ||
				observed.status.health !== "healthy" ||
				!observed.forwarded(forward.local, forward.remote)
			)
				throw new Error(
					"SQL requires the exact live ready owned single-replica pod and its declared loopback forward on the query port",
				);
		}
		if (process instanceof ContainerProcess) {
			const observed =
				handle instanceof ComposeProcess
					? process.runtimeStatus
					: await process.refresh(signal);
			if (
				observed?.health !== "healthy" ||
				observed.owned !== true ||
				observed.state !== "running"
			)
				throw new Error(
					"SQL requires the exact live health-ready owned infrastructure container",
				);
		}
		// Attached shared acquisitions approve prerequisites without starting a second
		// copy. When the named requiring app lives in another batch than the shared
		// infrastructure, resolve its exact approved closure and require exact plan
		// identity for every reused generation. Same owner/task only; no cross-owner
		// or workspace-mismatched adoption, no fallback to another requiring app.
		if (requiringApp !== undefined) {
			const named = runs.filter(
				(item) =>
					item.plan.projectKind === "app" && item.plan.app === requiringApp,
			);
			if (named.length === 1 && named[0] && named[0].batch !== run.batch) {
				const app = named[0];
				if (!sharedRoot(app.plan) || !sharedRoot(run.plan))
					throw new Error(
						"SQL requires the selected live held application whose immutable dependency plan requires this infrastructure; no fallback to another requiring app",
					);
				const snapshot = await this.authority
						.store()
						.snapshot(EnvironmentState, background),
					approved = batchApproved(snapshot?.waits, app.batch, owner.id),
					rootApproved = approved?.find((plan) => plan.app === app.plan.app);
				if (
					!approved ||
					!rootApproved ||
					!sameApprovedPlan(rootApproved, app.plan)
				)
					throw new Error(
						"SQL requires the selected live held application whose immutable dependency plan requires this infrastructure; no fallback to another requiring app",
					);
				const closure = declaredInfrastructure(rootApproved, [...approved]),
					expected = closure.find((plan) => plan.app === infra);
				if (!expected || !sameApprovedPlan(expected, run.plan))
					throw new Error(
						"SQL requires the selected live held application whose immutable dependency plan requires this infrastructure; no fallback to another requiring app",
					);
				const alive = (item: EnvironmentRun) => {
					const live = this.authority.live.get(item.id);
					return (
						item.state === "running" &&
						live &&
						!live.closing &&
						!live.outcome &&
						!live.cleanupFailed
					);
				};
				const resolve = (plan: (typeof closure)[number]): EnvironmentRun => {
					const local = runs.filter(
						(member) =>
							member.batch === app.batch &&
							member.owner === app.owner &&
							member.plan.workspace === app.plan.workspace &&
							member.plan.app === plan.app &&
							sameApprovedPlan(member.plan, plan),
					);
					if (local.length === 1 && local[0]) return local[0];
					if (local.length > 1)
						throw new Error(
							"SQL requires the selected live held application whose immutable dependency plan requires this infrastructure; no fallback to another requiring app",
						);
					const shared = runs.filter(
						(member) =>
							member.owner === app.owner &&
							member.plan.workspace === app.plan.workspace &&
							sharedRoot(member.plan) &&
							member.plan.app === plan.app &&
							sameApprovedPlan(member.plan, plan) &&
							member.state === "running",
					);
					const only = shared[0];
					if (!only || shared.length !== 1)
						throw new Error(
							"SQL requires the selected live held application whose immutable dependency plan requires this infrastructure; no fallback to another requiring app",
						);
					return only;
				};
				const resources = closure.map(resolve),
					resourceRuns = resources
						.map((item) => item.id)
						.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
					required = [app, ...resources];
				if (!required.every(alive))
					throw new Error(
						"SQL requires the selected live held application whose immutable dependency plan requires this infrastructure; no fallback to another requiring app",
					);
				this.authority.check(owner.id, signal, run.batch, run);
				this.authority.check(owner.id, signal, app.batch, app);
				return {
					root: { run: app.id, resources: resourceRuns },
					run,
					process,
					service,
					app,
					members: required.map((item) => ({
						run: item,
						process: this.authority.live.get(item.id),
					})),
				};
			}
		}
		const members = runs.filter((item) => item.batch === run.batch),
			alive = (item: EnvironmentRun) => {
				const live = this.authority.live.get(item.id);
				return (
					item.state === "running" &&
					live &&
					!live.closing &&
					!live.outcome &&
					!live.cleanupFailed
				);
			};
		const candidates = members.filter(
			(item) =>
				item.plan.projectKind === "app" &&
				(requiringApp === undefined || item.plan.app === requiringApp),
		);
		const closures = candidates.map((app) => ({
			app,
			plans: declaredInfrastructure(
				app.plan,
				members.map((item) => item.plan),
			),
		}));
		const selected = closures.find((closure) =>
				closure.plans.some((plan) => plan.app === infra),
			),
			app = selected?.app;
		if (!selected || !app)
			throw new Error(
				"SQL requires the selected live held application whose immutable dependency plan requires this infrastructure; no fallback to another requiring app",
			);
		const resourceRuns = selected.plans
			.map((plan) => {
				const resource = members.find((member) => member.plan === plan);
				if (!resource)
					throw new Error("SQL prerequisite generation is unavailable");
				return resource.id;
			})
			.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
		// Referenced roots keep whole-acquisition holdings but independent stop:
		// only this root generation and its declared prerequisites must be live.
		const required =
			app.plan.lifetime === referencedLifetime
				? [app, ...members.filter((item) => resourceRuns.includes(item.id))]
				: members;
		if (!required.every(alive))
			throw new Error(
				"SQL requires the selected live held application whose immutable dependency plan requires this infrastructure; no fallback to another requiring app",
			);
		this.authority.check(owner.id, signal, run.batch, run);
		if (requiringApp !== undefined)
			this.authority.check(owner.id, signal, app.batch, app);
		return {
			root:
				requiringApp === undefined
					? undefined
					: {
							run: app.id,
							resources: resourceRuns,
						},
			run,
			process,
			service,
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
		queryInput(input.infra, input.sql, input.limit, input.schema, input.app);
		const { run, app, root, service } = await this.held(
				owner,
				input.infra,
				signal,
				input.app,
			),
			connection = run.plan.queryConnection;
		if (!connection) throw new Error("Query connection is unavailable");
		return {
			input,
			run: run.id,
			app: app.plan.app,
			...(root ? { root } : {}),
			connection,
			...(service ? { service } : {}),
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
		const held = await this.held(
				owner,
				approved.input.infra,
				signal,
				approved.input.app,
			),
			{ run, process, app } = held;
		if (
			run.id !== approved.run ||
			held.service !== approved.service ||
			app.plan.app !== approved.app ||
			JSON.stringify(held.root) !== JSON.stringify(approved.root) ||
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
				this.authority.check(owner.id, bounded, run.batch, run);
				if (held.root) this.authority.check(owner.id, bounded, app.batch, app);
				for (const member of held.members)
					if (
						!member.process ||
						this.authority.live.get(member.run.id) !== member.process ||
						member.process.closing ||
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
				current = await this.held(
					owner,
					approved.input.infra,
					bounded,
					approved.input.app,
				);
			check();
			if (
				current.run.id !== run.id ||
				current.process !== process ||
				current.app.id !== app.id ||
				JSON.stringify(current.root) !== JSON.stringify(held.root)
			)
				throw new Error("SQL ownership changed; response discarded");
			const response = {
				...result,
				run: run.id,
				infra: approved.input.infra,
				...(held.service ? { service: held.service } : {}),
				app: app.plan.app,
				...(held.root ? { root: held.root } : {}),
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
			runId: held.root ? app.id : run.id,
		});
		try {
			return await operation;
		} finally {
			this.authority.pending.delete(operation);
		}
	}
}
