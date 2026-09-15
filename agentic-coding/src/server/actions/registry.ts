// Versioned action-definition registry (`port-action-execution-to-bun`,
// task 1.3).
//
// Ported from `server/pkg/actionregistry/registry.go`.
//
// The contract is one atomic publication: every provider compiles, every
// definition validates, duplicate ids are rejected, and only then does a new
// snapshot replace the previous one. A run that started under version N keeps
// version N's definition snapshot (task 1.4), so a half-published registry
// would let a run's identity change underneath it. A failed rebuild leaves the
// previous snapshot current and the caller sees the error.
import type { ActionDefinition, ActionResourceRef } from "@devenv/types";
import { newAction, validateAction } from "./definition.ts";

export class ActionSnapshot {
	readonly version: number;
	readonly definitions: readonly ActionDefinition[];
	readonly diagnostics: readonly string[];
	readonly #byId: Map<string, ActionDefinition>;

	constructor(
		version: number,
		definitions: readonly ActionDefinition[],
		diagnostics: readonly string[] = [],
	) {
		this.version = version;
		this.diagnostics = diagnostics;
		const byId = new Map<string, ActionDefinition>();
		this.definitions = definitions
			.map((definition) => {
				const copy = newAction(definition);
				byId.set(copy.id, copy);
				return copy;
			})
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		this.#byId = byId;
	}

	/** The definition for `id`, copied so the snapshot stays immutable. */
	get(id: string): ActionDefinition | undefined {
		const definition = this.#byId.get(id);
		return definition ? newAction(definition) : undefined;
	}

	/** Every definition owned by one resource, in id order. */
	forResource(owner: ActionResourceRef): ActionDefinition[] {
		return this.definitions
			.filter((d) => d.owner.kind === owner.kind && d.owner.id === owner.id)
			.map(newAction);
	}
}

export interface ActionProvider {
	readonly name: string;
	/** May read configuration; the registry itself never does I/O. */
	compile(): readonly ActionDefinition[] | Promise<readonly ActionDefinition[]>;
}

/**
 * Compiles every provider, validates every definition, rejects duplicate ids,
 * and publishes the result as one new version. On failure the previously
 * published snapshot stays current and the error is thrown.
 */
export class ActionRegistry {
	#current = new ActionSnapshot(0, []);

	snapshot(): ActionSnapshot {
		return this.#current;
	}

	async rebuild(
		providers: readonly ActionProvider[],
		handlers?: { has(kind: string): boolean },
	): Promise<ActionSnapshot> {
		const definitions: ActionDefinition[] = [];
		const compiledBy = new Map<string, string>();
		for (const provider of providers) {
			const compiled = await provider.compile();
			for (const definition of compiled) {
				const previous = compiledBy.get(definition.id);
				if (previous !== undefined) {
					throw new Error(
						`duplicate action id ${definition.id} from providers ${previous} and ${provider.name}; resource=${definition.owner.kind} action=${definition.type} runtime=${definition.runtime}`,
					);
				}
				try {
					validateAction(definition, handlers);
				} catch (error) {
					throw new Error(
						`provider ${provider.name} action ${definition.id}: ${messageOf(error)}`,
					);
				}
				compiledBy.set(definition.id, provider.name);
				definitions.push(newAction(definition));
			}
		}
		this.#current = new ActionSnapshot(this.#current.version + 1, definitions);
		return this.#current;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
