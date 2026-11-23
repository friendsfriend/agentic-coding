import type { JsonSchema } from "../interface/descriptors.ts";
import type { UiActionDescriptor, UiCapabilityApi } from "./capability-api.ts";
import { formatTelemetryResult } from "./telemetry-format.ts";

/** Form-field description derived from a capability's JSON Schema. The UI only
 * supports the flat scalar objects the capability registry currently declares;
 * adding a nested schema is a deliberate UI change, not an implicit fallback. */
export type UiFieldKind = "string" | "number" | "integer" | "boolean";
export type UiField = {
	name: string;
	kind: UiFieldKind;
	required: boolean;
	description?: string;
	defaultValue?: string;
	enumValues?: string[];
	pattern?: string;
};
export function fieldsFromSchema(schema: JsonSchema): UiField[] {
	if (schema.type !== "object")
		throw new Error("Capability input must be an object");
	const properties =
		typeof schema.properties === "object" && schema.properties !== null
			? (schema.properties as Record<string, JsonSchema>)
			: {};
	const required = new Set(
		Array.isArray(schema.required)
			? schema.required.filter(
					(name): name is string => typeof name === "string",
				)
			: [],
	);
	return Object.entries(properties).map(([name, property]) => {
		const kind = property.type;
		if (!["string", "number", "integer", "boolean"].includes(String(kind)))
			throw new Error(`Unsupported UI field: ${name}`);
		const values = Array.isArray(property.enum)
			? property.enum.filter(
					(value): value is string => typeof value === "string",
				)
			: undefined;
		const fallback =
			typeof property.default === "string" ||
			typeof property.default === "number" ||
			typeof property.default === "boolean"
				? String(property.default)
				: undefined;
		return {
			name,
			kind: kind as UiFieldKind,
			required: required.has(name),
			description:
				typeof property.description === "string"
					? property.description
					: undefined,
			defaultValue: fallback,
			enumValues: values?.length ? values : undefined,
			pattern:
				typeof property.pattern === "string" ? property.pattern : undefined,
		};
	});
}

export type EnvironmentUiView =
	| "loading"
	| "list"
	| "form"
	| "running"
	| "traces"
	| "result"
	| "error";
export type UiTraceSummary = {
	traceId: string;
	root: string;
	spanCount: number;
	errors: number;
};
export type EnvironmentUiSnapshot = {
	view: EnvironmentUiView;
	actions: readonly UiActionDescriptor[];
	selectedIndex: number;
	action?: UiActionDescriptor;
	fields: readonly UiField[];
	values: Readonly<Record<string, string>>;
	traces?: readonly UiTraceSummary[];
	traceIndex: number;
	result?: string;
	message?: string;
};
export type EnvironmentUiController = {
	getSnapshot(): EnvironmentUiSnapshot;
	subscribe(listener: () => void): () => void;
	load(): Promise<void>;
	moveSelection(delta: number): void;
	select(index: number): void;
	openSelected(): void;
	setValue(name: string, value: string): void;
	selectTrace(index: number): void;
	moveTrace(delta: number): void;
	openTrace(): Promise<void>;
	submit(): Promise<void>;
	cancel(): void;
	back(): void;
};

export function createEnvironmentUiController(
	api: UiCapabilityApi,
): EnvironmentUiController {
	let actions: readonly UiActionDescriptor[] = [];
	let selectedIndex = 0;
	let action: UiActionDescriptor | undefined;
	let fields: readonly UiField[] = [];
	let values: Record<string, string> = {};
	let view: EnvironmentUiView = "loading";
	let result: string | undefined;
	let message: string | undefined;
	let traces: UiTraceSummary[] | undefined;
	let traceIndex = 0;
	let traceAction: UiActionDescriptor | undefined;
	let traceInput: Record<string, unknown> | undefined;
	let traceSummary: string | undefined;
	let pending: AbortController | undefined;
	let loadGeneration = 0;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	const snapshot = (): EnvironmentUiSnapshot => ({
		view,
		actions,
		selectedIndex,
		action,
		fields,
		values,
		traces,
		traceIndex,
		result,
		message,
	});
	const fail = (code: string) => {
		view = "error";
		message = code;
		pending = undefined;
	};
	return {
		getSnapshot: snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async load() {
			const generation = ++loadGeneration;
			view = "loading";
			message = undefined;
			notify();
			try {
				const next = await api.list();
				if (generation !== loadGeneration) return;
				actions = next;
				selectedIndex = Math.min(
					selectedIndex,
					Math.max(0, actions.length - 1),
				);
				view = actions.length ? "list" : "error";
				message = actions.length ? undefined : "No capabilities available";
			} catch (error) {
				if (generation !== loadGeneration) return;
				fail(
					error instanceof Error && error.message
						? error.message
						: "capability-list-failed",
				);
			}
			notify();
		},
		moveSelection(delta) {
			if (view !== "list" || !actions.length) return;
			selectedIndex = (selectedIndex + delta + actions.length) % actions.length;
			notify();
		},
		select(index) {
			if (view !== "list" || !actions.length) return;
			if (!Number.isInteger(index) || index < 0 || index >= actions.length)
				return;
			selectedIndex = index;
		},
		openSelected() {
			if (view !== "list") return;
			const next = actions[selectedIndex];
			if (!next) return;
			try {
				const nextFields = fieldsFromSchema(next.inputSchema);
				const nextValues: Record<string, string> = {};
				for (const field of nextFields)
					nextValues[field.name] =
						field.defaultValue ??
						(field.name === "requestId" ? crypto.randomUUID() : undefined) ??
						field.enumValues?.[0] ??
						(field.kind === "boolean" ? "false" : "");
				action = next;
				fields = nextFields;
				values = nextValues;
				result = undefined;
				message = undefined;
				traces = undefined;
				traceIndex = 0;
				traceAction = undefined;
				traceInput = undefined;
				traceSummary = undefined;
				view = "form";
			} catch (error) {
				fail(error instanceof Error ? error.message : "unsupported-input");
			}
			notify();
		},
		setValue(name, value) {
			if (view !== "form" || !fields.some((field) => field.name === name))
				return;
			// The focused input owns its display; re-rendering here would destroy
			// the editor on every keystroke and lose focus.
			values = { ...values, [name]: value };
		},
		async submit() {
			if (view !== "form" || !action) return;
			const input: Record<string, unknown> = {};
			for (const field of fields) {
				const raw = (values[field.name] ?? "").trim();
				if (!raw) {
					if (field.required) {
						message = `Required: ${field.name}`;
						notify();
						return;
					}
					continue;
				}
				if (field.enumValues && !field.enumValues.includes(raw)) {
					message = `Allowed values for ${field.name}: ${field.enumValues.join(", ")}`;
					notify();
					return;
				}
				if (field.pattern && !new RegExp(field.pattern).test(raw)) {
					message = `Invalid format: ${field.name}`;
					notify();
					return;
				}
				if (field.kind === "number" || field.kind === "integer") {
					const parsed = Number(raw);
					if (
						!Number.isFinite(parsed) ||
						(field.kind === "integer" && !Number.isInteger(parsed))
					) {
						message = `Invalid number: ${field.name}`;
						notify();
						return;
					}
					input[field.name] = parsed;
				} else if (field.kind === "boolean") {
					if (raw !== "true" && raw !== "false") {
						message = `Choose true or false: ${field.name}`;
						notify();
						return;
					}
					input[field.name] = raw === "true";
				} else input[field.name] = raw;
			}
			pending = new AbortController();
			view = "running";
			message = undefined;
			result = undefined;
			notify();
			try {
				const value = await api.invoke(action.name, input, {
					signal: pending.signal,
				});
				if (!pending) return;
				if (action.name === "env_telemetry") {
					try {
						const selected = formatTelemetryResult(value);
						const summaries = Array.isArray(value.traces)
							? value.traces.flatMap((raw) => {
									if (!raw || typeof raw !== "object") return [];
									const entry = raw as Record<string, unknown>;
									if (
										typeof entry.traceId !== "string" ||
										!/^[a-f0-9]{32}$/.test(entry.traceId)
									)
										return [];
									return [
										{
											traceId: entry.traceId,
											root:
												typeof entry.root === "string"
													? entry.root
													: "(unnamed)",
											spanCount:
												typeof entry.spanCount === "number"
													? entry.spanCount
													: 0,
											errors:
												typeof entry.errors === "number" ? entry.errors : 0,
										},
									];
								})
							: [];
						if (summaries.length) {
							traces = summaries;
							traceIndex = 0;
							traceAction = action;
							traceInput = {
								app: String(input.app),
								...(typeof input.repository === "string"
									? { repository: input.repository }
									: {}),
							};
							traceSummary = selected;
							result = selected;
							view = "traces";
							notify();
							return;
						}
						result = selected;
					} catch {
						result = JSON.stringify(value, null, 2);
					}
				} else {
					result = JSON.stringify(value, null, 2);
					traces = undefined;
					traceAction = undefined;
					traceInput = undefined;
					traceSummary = undefined;
				}
				view = "result";
			} catch (error) {
				if (!pending) return;
				fail(
					error instanceof Error && error.message
						? error.message
						: "capability-failed",
				);
			} finally {
				pending = undefined;
			}
			notify();
		},
		selectTrace(index: number) {
			if (view !== "traces" || !traces?.length) return;
			if (!Number.isInteger(index) || index < 0 || index >= traces.length)
				return;
			traceIndex = index;
			notify();
		},
		moveTrace(delta: number) {
			if (view !== "traces" || !traces?.length) return;
			traceIndex = (traceIndex + delta + traces.length) % traces.length;
			notify();
		},
		async openTrace() {
			if (view !== "traces" || !traceAction || !traceInput) return;
			const selected = traces?.[traceIndex];
			if (!selected) return;
			pending = new AbortController();
			view = "running";
			message = undefined;
			notify();
			try {
				const value = await api.invoke(
					traceAction.name,
					{ ...traceInput, traceId: selected.traceId },
					{ signal: pending.signal },
				);
				if (!pending) return;
				try {
					result = formatTelemetryResult(value);
				} catch {
					result = JSON.stringify(value, null, 2);
				}
				view = "result";
			} catch (error) {
				if (!pending) return;
				fail(
					error instanceof Error && error.message
						? error.message
						: "capability-failed",
				);
			} finally {
				pending = undefined;
			}
			notify();
		},
		cancel() {
			if (view !== "running" || !pending) return;
			pending.abort();
			pending = undefined;
			view = "list";
			message = "Cancelled";
			notify();
		},
		back() {
			if (view === "running") return;
			if (view === "result" && traces?.length) {
				view = "traces";
				result = traceSummary;
				message = undefined;
				notify();
				return;
			}
			if (view === "traces") {
				view = "list";
				traces = undefined;
				traceAction = undefined;
				traceInput = undefined;
				traceSummary = undefined;
				result = undefined;
				message = undefined;
				notify();
				return;
			}
			if (view === "form" || view === "result" || view === "error") {
				view = "list";
				traces = undefined;
				traceAction = undefined;
				traceInput = undefined;
				traceSummary = undefined;
				action = undefined;
				fields = [];
				values = {};
				result = undefined;
				message = undefined;
				notify();
			}
		},
	};
}
