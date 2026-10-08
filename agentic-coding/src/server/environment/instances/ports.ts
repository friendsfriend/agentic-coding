import net from "node:net";
import type { PortAllocationRecord } from "../state-store.ts";
import type { EnvironmentOwner } from "./model.ts";

export class PortUnavailableError extends Error {
	readonly code = "port-unavailable";
	constructor(message: string) {
		super(message);
		this.name = "PortUnavailableError";
	}
}

export interface PortAllocationStore {
	getPortAllocations(instanceId?: string): PortAllocationRecord[];
	setPortAllocation(allocation: PortAllocationRecord): boolean;
	deletePortAllocations(instanceId: string): void;
}

export interface PortRange {
	readonly start: number;
	readonly end: number;
}

export function parsePortRange(value: string): PortRange {
	const match = value.trim().match(/^(\d{1,5})\s*-\s*(\d{1,5})$/);
	if (!match)
		throw new PortUnavailableError(
			`invalid environment.instances.port_range ${JSON.stringify(value)}`,
		);
	const start = Number(match[1]);
	const end = Number(match[2]);
	if (start < 1 || end > 65535 || end < start)
		throw new PortUnavailableError(
			`invalid environment.instances.port_range ${JSON.stringify(value)}`,
		);
	return { start, end };
}

/** Port names are discovered from literal Compose/script references. */
export function scanPortNames(source: string): string[] {
	const names = new Set<string>();
	for (const match of source.matchAll(/\bAC_PORT_([A-Z][A-Z0-9_]*)\b/g)) {
		if (match[1]) names.add(match[1]);
	}
	return [...names].sort();
}

export interface PortAllocatorOptions {
	readonly store: PortAllocationStore;
	readonly isBindable?: (port: number) => Promise<boolean>;
}

/** Allocates stable named ports, checking both persisted allocations and bindability. */
export class EnvironmentPortAllocator {
	private readonly store: PortAllocationStore;
	private readonly isBindable: (port: number) => Promise<boolean>;

	constructor(options: PortAllocatorOptions) {
		this.store = options.store;
		this.isBindable = options.isBindable ?? isLoopbackPortBindable;
	}

	async allocate(input: {
		readonly instanceId: string;
		readonly owner: EnvironmentOwner;
		readonly source: string;
		readonly range: PortRange;
		readonly excludePorts?: readonly number[];
	}): Promise<Record<string, number>> {
		if (input.owner === "user") return {};
		const existing = new Map(
			this.store
				.getPortAllocations(input.instanceId)
				.map((allocation) => [allocation.name, allocation.port]),
		);
		const excluded = new Set(input.excludePorts ?? []);
		const allUsed = new Set([
			...this.store.getPortAllocations().map((item) => item.port),
			...excluded,
		]);
		const allocated: Record<string, number> = {};
		for (const name of scanPortNames(input.source)) {
			const prior = existing.get(name);
			if (
				prior !== undefined &&
				!excluded.has(prior) &&
				(await this.isBindable(prior))
			) {
				allocated[name] = prior;
				continue;
			}
			let found: number | undefined;
			for (let port = input.range.start; port <= input.range.end; port++) {
				if (allUsed.has(port) || !(await this.isBindable(port))) continue;
				if (
					!this.store.setPortAllocation({
						instanceId: input.instanceId,
						name,
						port,
					})
				) {
					allUsed.add(port);
					continue;
				}
				found = port;
				allUsed.add(port);
				break;
			}
			if (found === undefined)
				throw new PortUnavailableError(
					`no available port in ${input.range.start}-${input.range.end} for AC_PORT_${name}`,
				);
			allocated[name] = found;
		}
		return allocated;
	}

	free(instanceId: string): void {
		this.store.deletePortAllocations(instanceId);
	}
}

async function isLoopbackPortBindable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => {
			server.close(() => resolve(true));
		});
	});
}
