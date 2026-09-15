// Typed named values for an environment action run
// (`port-action-execution-to-bun`, task 2.2).
//
// Ported from `server/pkg/actionexec/{engine.go,command.go}` value handling.
//
// A value carries its declared type and visibility with it. The store is
// per-run and shared by every step, which is what makes `captureStdout` on one
// step consumable by a `${key}` template on a later one — and why a step's
// declared scope/visibility is a contract, not decoration: a secret value may
// only be handed to an authorized consumer, and never reaches a snapshot.
export type ValueType = string;
export type ValueVisibility = "public" | "internal" | "secret" | "ephemeral";

export const VALUE_TYPE_ENDPOINT = "endpoint";

export interface Value {
	type: ValueType;
	visibility: ValueVisibility;
	data: unknown;
}

/** A typed endpoint value; the shape a readiness or export step publishes. */
export interface EndpointValue {
	name: string;
	protocol: string;
	host: string;
	port: number;
}

export class ValueStore {
	readonly #values = new Map<string, Value>();

	constructor(inputs: ReadonlyMap<string, Value> = new Map()) {
		for (const [key, value] of inputs) this.#values.set(key, value);
	}

	get(key: string): Value | undefined {
		return this.#values.get(key);
	}

	has(key: string): boolean {
		return this.#values.has(key);
	}

	set(key: string, value: Value): void {
		this.#values.set(key, value);
	}
}

/** The error a step sees when it consumes a value nothing produced. */
export function missingValueError(key: string): Error {
	return new Error(`required value ${key} missing`);
}

/**
 * `fmt.Sprint` for a captured value. Scalars are exact; arrays and maps follow
 * Go's rendering (`[a b]`, `map[k:v]` with sorted keys) because a wrong template
 * substitution silently changes a command's argv.
 */
export function formatValue(value: Value): string {
	if (value.type === VALUE_TYPE_ENDPOINT) {
		const endpoint = asEndpoint(value.data);
		if (endpoint) {
			return `${endpoint.protocol}://${endpoint.host}:${endpoint.port}`;
		}
	}
	return goSprint(value.data);
}

function asEndpoint(data: unknown): EndpointValue | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	if (!("protocol" in record) || !("host" in record) || !("port" in record)) {
		return undefined;
	}
	return {
		name: typeof record.name === "string" ? record.name : "",
		protocol: String(record.protocol),
		host: String(record.host),
		port: Number(record.port),
	};
}

function goSprint(data: unknown): string {
	if (data === null || data === undefined) return "<nil>";
	if (Array.isArray(data)) return `[${data.map(goSprint).join(" ")}]`;
	if (typeof data === "object") {
		const record = data as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return `map[${keys.map((key) => `${key}:${goSprint(record[key])}`).join(" ")}]`;
	}
	return String(data);
}

const TEMPLATE_PREFIX = "${";

/**
 * Substitutes `${key}` placeholders in a command's argv or environment against
 * the run's value store. An unclosed placeholder is a hard error rather than a
 * literal argument, so a malformed configuration cannot reach a process.
 */
export function resolveValueTemplates(
	values: ValueStore,
	args: readonly string[],
): string[] {
	return args.map((arg) => {
		let resolved = arg;
		for (;;) {
			const start = resolved.indexOf(TEMPLATE_PREFIX);
			if (start < 0) break;
			const end = resolved.indexOf("}", start + 2);
			if (end < 0) {
				throw new Error(`invalid value template ${JSON.stringify(arg)}`);
			}
			const key = resolved.slice(start + 2, end);
			const value = values.get(key);
			if (value === undefined) throw missingValueError(key);
			resolved =
				resolved.slice(0, start) + formatValue(value) + resolved.slice(end + 1);
		}
		return resolved;
	});
}
