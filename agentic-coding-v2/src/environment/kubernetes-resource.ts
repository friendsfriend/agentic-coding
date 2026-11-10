import { object } from "../config.ts";
import type { EnvironmentCommands } from "./command.ts";
export type CreatedResource = {
	uid: string;
	version: string;
	data: Record<string, unknown>;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Private creation capability for two fixed namespaced API kinds only. A durable
 * name/label, list result or occupied resource can never issue this capability. */
export class KubernetesResource {
	private receipt: CreatedResource | undefined;
	private attempted = false;
	private released = false;
	private uncertain = false;
	constructor(
		private commands: EnvironmentCommands,
		readonly kind: "Deployment" | "Service",
		readonly namespace: string,
		readonly name: string,
		private labels: Record<string, string>,
	) {}
	get uid() {
		return this.receipt?.uid ?? null;
	}
	get cleanupFailed() {
		return this.uncertain || (this.attempted && !this.receipt);
	}
	get apiVersion() {
		return this.kind === "Deployment" ? "apps/v1" : "v1";
	}
	get collection() {
		return `${this.kind === "Deployment" ? "/apis/apps/v1" : "/api/v1"}/namespaces/${encodeURIComponent(this.namespace)}/${this.kind === "Deployment" ? "deployments" : "services"}`;
	}
	private parse(raw: unknown): CreatedResource {
		const data = object(raw),
			metadata = object(data.metadata);
		if (
			data.apiVersion !== this.apiVersion ||
			data.kind !== this.kind ||
			metadata.name !== this.name ||
			metadata.namespace !== this.namespace ||
			typeof metadata.uid !== "string" ||
			!uuid.test(metadata.uid) ||
			typeof metadata.resourceVersion !== "string" ||
			!/^[1-9][0-9]{0,30}$/.test(metadata.resourceVersion)
		)
			throw new Error("Invalid private Kubernetes resource identity");
		return { uid: metadata.uid, version: metadata.resourceVersion, data };
	}
	private owns(resource: CreatedResource) {
		const metadata = object(resource.data.metadata),
			labels = object(metadata.labels);
		return Object.entries(this.labels).every(
			([key, value]) => labels[key] === value,
		);
	}
	async observe(
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<CreatedResource | null> {
		try {
			const raw = await this.commands.checked(
				[
					"get",
					"--raw",
					`${this.collection}?fieldSelector=${encodeURIComponent(`metadata.name=${this.name}`)}`,
				],
				{ timeoutMs, signal, machine: true },
			);
			const list = object(JSON.parse(raw));
			if (
				list.apiVersion !== this.apiVersion ||
				list.kind !== `${this.kind}List` ||
				!Array.isArray(list.items) ||
				list.items.length > 1
			)
				throw new Error();
			if (!list.items.length) return null;
			const found = this.parse(list.items[0]);
			if (
				this.receipt &&
				(found.uid !== this.receipt.uid || !this.owns(found))
			) {
				this.uncertain = true;
				throw new Error();
			}
			return found;
		} catch {
			throw new Error(
				"Kubernetes resource observation failed; original identity and absence are not confirmed",
			);
		}
	}
	async create(
		manifest: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
	) {
		if (this.attempted || this.receipt || this.released)
			throw new Error("Kubernetes resource creation cannot be replayed");
		const deadline = Date.now() + timeoutMs;
		if (await this.observe(timeoutMs, signal))
			throw new Error(
				"Kubernetes resource name is occupied; no existing resource was adopted",
			);
		const input = JSON.stringify(manifest);
		if (Buffer.byteLength(input) > 1048576)
			throw new Error("Kubernetes resource request exceeds its size bound");
		const left = deadline - Date.now();
		if (left <= 0)
			throw new Error(
				"Kubernetes resource creation budget expired before dispatch",
			);
		this.attempted = true;
		const raw = await this.commands.checked(
			["create", "--raw", this.collection, "-f", "-"],
			{ timeoutMs: left, signal, machine: true, effect: true, input },
		);
		try {
			const created = this.parse(JSON.parse(raw));
			if (!this.owns(created)) throw new Error();
			this.receipt = created;
			return created;
		} catch {
			this.uncertain = true;
			throw new Error(
				"Kubernetes resource creation receipt is invalid; refusing name-based adoption",
			);
		}
	}
	async remove(timeoutMs: number) {
		if (this.released || !this.attempted) return;
		if (!this.receipt) {
			this.uncertain = true;
			throw new Error(
				"No original Kubernetes creation receipt; resource retained for inspection",
			);
		}
		const deadline = Date.now() + timeoutMs;
		const current = await this.observe(timeoutMs);
		if (!current) {
			this.uncertain = true;
			throw new Error(
				"Original Kubernetes resource disappeared before cleanup; no replacement was adopted",
			);
		}
		const left = deadline - Date.now();
		if (left <= 0)
			throw new Error(
				"Kubernetes resource cleanup budget expired before dispatch",
			);
		await this.commands.checked(
			[
				"delete",
				"--raw",
				`${this.collection}/${encodeURIComponent(this.name)}`,
				"-f",
				"-",
			],
			{
				timeoutMs: left,
				machine: true,
				effect: true,
				input: JSON.stringify({
					apiVersion: "v1",
					kind: "DeleteOptions",
					propagationPolicy: "Foreground",
					preconditions: { uid: this.receipt.uid },
				}),
			},
		);
		while (Date.now() < deadline) {
			if (!(await this.observe(Math.max(1, deadline - Date.now())))) {
				this.released = true;
				return;
			}
			await Bun.sleep(50);
		}
		this.uncertain = true;
		throw new Error(
			"Original Kubernetes resource deletion did not settle; foreground cleanup retained for inspection",
		);
	}
}
