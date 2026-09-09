// Negative fixture: computed module loading in a guarded pure module escapes
// static resolution and must be rejected.
export function loadByKey(key: string): Promise<unknown> {
	return import(`./adapters/${key}.ts`);
}

export function legacyLoad(key: string): unknown {
	return require(`./legacy/${key}`);
}