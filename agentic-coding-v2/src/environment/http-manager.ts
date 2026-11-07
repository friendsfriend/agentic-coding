import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../config.ts";
import { decode, type TaskInfo } from "../state.ts";
import type { LiveEnvironmentAuthority } from "./authority.ts";
import { ComposeProcess } from "./compose.ts";
import { ContainerProcess } from "./container.ts";
import {
	type DiagnosticSelection,
	diagnosticHistory,
} from "./diagnostic-history.ts";
import { type EndpointRequest, endpointUrl } from "./endpoint.ts";
import { loadEndpointCa, prepareEndpointCa } from "./endpoint-ca.ts";
import { endpointRequest } from "./http.ts";
import { type HttpOptions, httpOptions } from "./http-options.ts";
import {
	type HttpInput,
	type HttpReceipt,
	httpDigest,
	replayHttp,
} from "./http-receipts.ts";
import { KubernetesProcess } from "./kubernetes.ts";
import type { Plan } from "./model.ts";
import {
	batchApproved,
	type ReferenceScope,
	referenceScope,
	requireScopeLive,
} from "./reference-scope.ts";
import { ShellProcess } from "./shell.ts";
import { EnvironmentState } from "./state.ts";

export class HeldHttp {
	constructor(
		private config: Config,
		private authority: LiveEnvironmentAuthority,
	) {}
	/** Developer history only: never prepares an endpoint or restores a lease.
	 * Approved request bodies/headers, URLs and secret references are withheld. */
	async history(runId: string, selection: DiagnosticSelection = {}) {
		const run = (await this.authority.records()).find(
			(item) =>
				item.id === runId && Object.keys(item.plan.endpoints ?? {}).length > 0,
		);
		if (!run) throw new Error("Unknown HTTP diagnostic run");
		const doc = await this.authority
			.store()
			.snapshot(EnvironmentState, background);
		return diagnosticHistory<HttpReceipt>(
			doc?.httpOperations,
			run,
			selection,
			"HTTP",
			(receipt) => receipt.approved.app === run.plan.app,
			(receipt) => ({
				app: run.plan.app,
				endpoint: receipt.approved.endpoint,
				...(receipt.approved.service
					? { service: receipt.approved.service }
					: {}),
				method: receipt.approved.http?.method ?? "GET",
			}),
		);
	}
	/** The frozen declaration must bind the endpoint to an exact loopback
	 * publication. Separate live observation checks health/creation identity;
	 * neither a declaration nor an engine fixture proves actual networking. */
	private endpointAdmission(run: Plan, base: string, endpoint: string) {
		if (run.runtime === "shell") return;
		const url = new URL(base),
			port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		if (run.runtime === "kubernetes") {
			// The declaration must name the exact loopback port forward this run
			// starts; the forward pins its replica explicitly, and live
			// ownership and readiness are observed separately.
			if (
				run.kubernetes?.portForwards?.filter(
					(forward) => forward.local === port,
				).length !== 1
			)
				throw new Error(
					"Endpoint on a Kubernetes target requires exactly one declared loopback port forward on the endpoint's own port",
				);
			return;
		}
		const container =
			run.container ??
			run.composePlan?.services.find(
				(service) => service.id === run.endpointServices?.[endpoint],
			)?.container;
		if (
			container?.readiness !== "healthy" ||
			!container.ports.some(
				(port) =>
					port.protocol === "tcp" &&
					port.host ===
						Number(url.port || (url.protocol === "https:" ? 443 : 80)) &&
					(port.address === url.hostname ||
						(port.address === "::1" && url.hostname === "[::1]")),
			)
		)
			throw new Error(
				"Endpoint requires a declared published TCP loopback port of the held container",
			);
	}
	private async endpointRun(
		owner: TaskInfo,
		app: string,
		endpoint: string,
		signal?: AbortSignal,
	) {
		this.authority.check(owner.id, signal);
		if (owner.policy !== "workspace-write")
			throw new Error(
				"Endpoint diagnostics require a workspace-write native task and separate approval",
			);
		const members = (await this.authority.records()).filter(
				(run) => run.owner === owner.id,
			),
			runs = members.filter(
				(run) =>
					run.plan.app === app && run.state === "running" && run.ready === true,
			);
		const run = runs.length === 1 ? runs[0] : undefined,
			handle = run ? this.authority.live.get(run.id) : undefined;
		const service = run?.plan.endpointServices?.[endpoint];
		const process =
			handle instanceof ComposeProcess && service
				? await handle.diagnosticService(service, signal)
				: handle;
		const url = run
				? new URL(run.plan.endpoints?.[endpoint] ?? "http://")
				: null,
			forward = url
				? run?.plan.kubernetes?.portForwards?.find(
						(candidate) =>
							candidate.local ===
							Number(url.port || (url.protocol === "https:" ? 443 : 80)),
					)
				: undefined,
			// One fresh observation per dispatch: a container's own engine status or
			// the owned pod with its declared forward, never a saved receipt.
			containerStatus =
				process instanceof ContainerProcess
					? handle instanceof ComposeProcess
						? process.runtimeStatus
						: await process.refresh(signal)
					: undefined,
			pod =
				process instanceof KubernetesProcess
					? await process.diagnostic(forward?.local ?? -1, signal)
					: undefined,
			forwardedLive =
				pod && forward ? pod.forwarded(forward.local, forward.remote) : false;
		if (
			!run ||
			(!(process instanceof ShellProcess) &&
				!(process instanceof ContainerProcess) &&
				!(process instanceof KubernetesProcess)) ||
			!process ||
			handle?.closing ||
			handle?.outcome ||
			handle?.cleanupFailed ||
			process.closing ||
			process.outcome ||
			process.cleanupFailed ||
			run.plan.workspace !== owner.workspace ||
			(process instanceof ContainerProcess &&
				(containerStatus?.health !== "healthy" ||
					containerStatus.owned !== true ||
					containerStatus.state !== "running")) ||
			(process instanceof KubernetesProcess &&
				(!pod ||
					!forwardedLive ||
					pod.status.health !== "healthy" ||
					pod.status.owned !== true ||
					pod.status.state !== "running"))
		)
			throw new Error(
				"Endpoint requires this task's live ready shell app, health-ready owned container or ready owned pod with its declared loopback port forward; saved receipts grant no network authority",
			);
		this.authority.check(owner.id, signal, run.batch, run);
		const snapshot = await this.authority
			.store()
			.snapshot(EnvironmentState, background);
		const root = referenceScope(
			run,
			members,
			batchApproved(snapshot?.waits, run.batch, owner.id),
		);
		if (root) requireScopeLive(root, members, this.authority.live);
		return { run, process, handle, root, service };
	}
	/** Revalidates the approved descriptor at dispatch and publication: a
	 * changed or closing prerequisite generation is never substituted. */
	private scopeOf(approved: EndpointRequest, root: ReferenceScope | undefined) {
		if (JSON.stringify(approved.root ?? null) !== JSON.stringify(root ?? null))
			throw new Error(
				"Approved endpoint root or prerequisite generation changed; no request sent",
			);
	}
	async prepare(
		owner: TaskInfo,
		app: string,
		endpoint: string,
		path: string,
		signal?: AbortSignal,
		http?: HttpOptions,
	): Promise<EndpointRequest> {
		const { run, root, service } = await this.endpointRun(
				owner,
				app,
				endpoint,
				signal,
			),
			base = run.plan.endpoints?.[endpoint];
		if (!base || !Object.hasOwn(run.plan.endpoints ?? {}, endpoint))
			throw new Error("Choose a declared endpoint of the held app");
		this.endpointAdmission(run.plan, base, endpoint);
		const ref = Object.hasOwn(run.plan.endpointCaRefs ?? {}, endpoint)
			? run.plan.endpointCaRefs?.[endpoint]
			: undefined;
		const options = http ? httpOptions(http) : undefined,
			auth =
				options?.authenticate &&
				Object.hasOwn(run.plan.endpointAuthRefs ?? {}, endpoint)
					? run.plan.endpointAuthRefs?.[endpoint]
					: undefined;
		if (options?.authenticate && !auth)
			throw new Error(
				"Authentication requires a configured endpoint secret reference",
			);
		return {
			run: run.id,
			app,
			endpoint,
			...(service ? { service } : {}),
			url: endpointUrl(base, path),
			...(root ? { root } : {}),
			...(options ? { http: options } : {}),
			...(auth ? { authentication: auth } : {}),
			...(ref ? { ca: prepareEndpointCa(this.config.configDir, ref) } : {}),
		};
	}
	async receipt(
		owner: TaskInfo,
		id: string,
		input: HttpInput,
		signal?: AbortSignal,
	) {
		this.authority.check(owner.id, signal);
		if (owner.policy !== "workspace-write")
			throw new Error("HTTP receipt requires its workspace-write native owner");
		const raw = await this.authority.store().commit(async (tx) => {
			const task = await tx.task(owner.id as TaskId);
			if (!task || task.abortRequested || task.state.status === "terminal")
				throw new Error("HTTP native owner has ended");
			return (await tx.doc(EnvironmentState)).httpOperations?.[id];
		}, background);
		this.authority.check(owner.id, signal);
		return raw ? replayHttp(decode<HttpReceipt>(raw), owner.id, input) : null;
	}
	async request(
		owner: TaskInfo,
		approved: EndpointRequest,
		signal?: AbortSignal,
		issuance?: { id: string; input: HttpInput },
	) {
		const { run, process, handle, root, service } = await this.endpointRun(
				owner,
				approved.app,
				approved.endpoint,
				signal,
			),
			base = run.plan.endpoints?.[approved.endpoint];
		this.scopeOf(approved, root);
		if (base) this.endpointAdmission(run.plan, base, approved.endpoint);
		if (
			run.id !== approved.run ||
			service !== approved.service ||
			!base ||
			!Object.hasOwn(run.plan.endpoints ?? {}, approved.endpoint) ||
			(Object.hasOwn(run.plan.endpointCaRefs ?? {}, approved.endpoint)
				? run.plan.endpointCaRefs?.[approved.endpoint]
				: undefined) !== approved.ca?.file ||
			new URL(base).origin !== new URL(approved.url).origin
		)
			throw new Error("Approved endpoint no longer belongs to the held run");
		const options = httpOptions(approved.http),
			auth =
				options.authenticate &&
				Object.hasOwn(run.plan.endpointAuthRefs ?? {}, approved.endpoint)
					? run.plan.endpointAuthRefs?.[approved.endpoint]
					: undefined;
		if (
			(options.authenticate && !auth) ||
			JSON.stringify(auth) !== JSON.stringify(approved.authentication) ||
			(auth && new URL(approved.url).protocol !== "https:")
		)
			throw new Error(
				"Approved endpoint authentication no longer matches the held run",
			);
		const authorization = auth
			? process.authorization(approved.endpoint)
			: undefined;
		if (auth && !authorization)
			throw new Error("Held endpoint credentials are unavailable");
		const ca = approved.ca
			? loadEndpointCa(this.config.configDir, approved.ca)
			: undefined;
		if (approved.http && !issuance)
			throw new Error(
				"HTTP operations require a durable native issuance identity",
			);
		if (
			issuance &&
			(issuance.input.app !== approved.app ||
				issuance.input.endpoint !== approved.endpoint ||
				endpointUrl(base, issuance.input.path) !== approved.url ||
				JSON.stringify(issuance.input.http) !== JSON.stringify(options))
		)
			throw new Error("HTTP issuance does not match the approved request");
		const operation = (async () => {
			if (issuance) {
				const previous = await this.authority.store().commit(async (tx) => {
					const task = await tx.task(owner.id as TaskId);
					this.authority.check(owner.id, signal, run.batch, run);
					if (!task || task.abortRequested || task.state.status === "terminal")
						throw new Error("HTTP native owner has ended");
					const doc = await tx.doc(EnvironmentState);
					this.authority.check(owner.id, signal, run.batch, run);
					doc.httpOperations ??= {};
					const receipts = doc.httpOperations,
						raw = receipts[issuance.id];
					if (raw) return decode<HttpReceipt>(raw);
					const receipt: HttpReceipt = {
						owner: owner.id,
						inputDigest: httpDigest(issuance.input),
						approved,
						issuedAt: Date.now(),
						state: "issued",
					};
					receipts[issuance.id] = JSON.stringify(receipt);
					return null;
				}, background);
				if (previous) return replayHttp(previous, owner.id, issuance.input);
			}
			this.authority.check(owner.id, signal, run.batch, run);
			if (
				handle?.closing ||
				process.closing ||
				process.outcome ||
				process.cleanupFailed
			)
				throw new Error("Endpoint app is closing; no request sent");
			const result = await endpointRequest(
					approved.url,
					options,
					process.redact,
					signal,
					ca,
					authorization,
					async () => {
						const current = await this.endpointRun(
							owner,
							approved.app,
							approved.endpoint,
							signal,
						);
						if (current.run.id !== run.id || current.process !== process)
							throw new Error("Endpoint ownership changed");
						return approved.ca
							? loadEndpointCa(this.config.configDir, approved.ca)
							: undefined;
					},
					() => {
						this.authority.check(owner.id, signal, run.batch, run);
						if (
							process.outcome ||
							process.cleanupFailed ||
							handle?.closing ||
							process.closing ||
							handle?.outcome ||
							handle?.cleanupFailed ||
							this.authority.live.get(run.id) !== handle
						)
							throw new Error("Endpoint app is closing; no request sent");
					},
				),
				current = await this.endpointRun(
					owner,
					approved.app,
					approved.endpoint,
					signal,
				);
			this.authority.check(owner.id, signal, run.batch, run);
			if (
				current.run.id !== run.id ||
				current.process !== process ||
				handle?.closing ||
				process.closing ||
				process.outcome ||
				process.cleanupFailed
			)
				throw new Error("Endpoint ownership changed; response discarded");
			const response = {
				...result,
				run: run.id,
				app: approved.app,
				endpoint: approved.endpoint,
				...(service ? { service } : {}),
				...(root ? { root } : {}),
				observedAt: Date.now(),
				...(approved.ca ? { caDigest: approved.ca.digest } : {}),
			};
			if (issuance)
				await this.authority.store().commit(async (tx) => {
					const task = await tx.task(owner.id as TaskId);
					this.authority.check(owner.id, signal, run.batch, run);
					if (!task || task.abortRequested || task.state.status === "terminal")
						throw new Error("HTTP native owner ended; response discarded");
					const doc = await tx.doc(EnvironmentState);
					this.authority.check(owner.id, signal, run.batch, run);
					if (
						process.outcome ||
						process.cleanupFailed ||
						handle?.closing ||
						process.closing ||
						handle?.outcome ||
						handle?.cleanupFailed ||
						this.authority.live.get(run.id) !== handle
					)
						throw new Error("Endpoint app ended; response discarded");
					const raw = doc.httpOperations?.[issuance.id];
					if (!raw)
						throw new Error(
							"HTTP issuance receipt is missing; no response accepted",
						);
					const receipt = decode<HttpReceipt>(raw);
					if (
						receipt.owner !== owner.id ||
						receipt.inputDigest !== httpDigest(issuance.input) ||
						receipt.state !== "issued" ||
						JSON.stringify(receipt.approved) !== JSON.stringify(approved)
					)
						throw new Error(
							"HTTP issuance identity changed; no response accepted",
						);
					if (doc.httpOperations)
						doc.httpOperations[issuance.id] = JSON.stringify({
							...receipt,
							state: "completed",
							result: response,
						});
				}, background);
			return response;
		})();
		this.authority.pending.set(operation, {
			owner: owner.id,
			batch: run.batch,
			runId: run.id,
		});
		try {
			return await operation;
		} finally {
			this.authority.pending.delete(operation);
		}
	}
}
