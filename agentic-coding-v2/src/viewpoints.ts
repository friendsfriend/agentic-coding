import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { text } from "./config.ts";
import {
	type NativeViewpoint,
	nativeViewpoint,
	uiView,
} from "./protocol/viewpoints.ts";
import type { Runtime } from "./runtime.ts";

const ViewpointState = defineDoc<{
	items: Record<string, string>;
	sequence: number;
}>({
	kind: "v2.ui-viewpoints",
	version: 1,
	scope: "session",
	initial: () => ({ items: {}, sequence: 0 }),
	checkpointWhen: () => true,
});
export async function readViewpoints(app: Runtime): Promise<NativeViewpoint[]> {
	const doc = await app.harness.snapshot(ViewpointState, context);
	return Object.values(doc?.items ?? {})
		.map((raw) => nativeViewpoint(JSON.parse(raw)))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function saveViewpoint(
	app: Runtime,
	input: { id: string; name: string; revision: number; view: unknown },
): Promise<NativeViewpoint> {
	const view = uiView(input.view),
		name = text(input.name, "viewpoint name", 100);
	if (
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
			input.id,
		) ||
		!name.trim() ||
		!Number.isSafeInteger(input.revision) ||
		input.revision < 0
	)
		throw new Error("Invalid viewpoint identity/revision");
	return app.harness.commit(async (tx) => {
		const doc = await tx.doc(ViewpointState),
			old = Object.hasOwn(doc.items, input.id)
				? nativeViewpoint(JSON.parse(doc.items[input.id]))
				: null;
		if (old?.name === name && JSON.stringify(old.view) === JSON.stringify(view))
			return old;
		if ((old?.revision ?? 0) !== input.revision)
			throw new Error("Stale viewpoint revision");
		if (!old && Object.keys(doc.items).length >= 32)
			throw new Error("Native viewpoint capacity reached");
		if (
			!Number.isSafeInteger(doc.sequence) ||
			doc.sequence >= Number.MAX_SAFE_INTEGER
		)
			throw new Error("Native UI revision sequence unavailable");
		const item: NativeViewpoint = {
			id: input.id,
			name,
			revision: ++doc.sequence,
			view,
			updatedAt: Date.now(),
		};
		doc.items[input.id] = JSON.stringify(item);
		return item;
	}, context);
}
export async function removeViewpoint(
	app: Runtime,
	id: string,
	revision: number,
) {
	await app.harness.commit(async (tx) => {
		const doc = await tx.doc(ViewpointState),
			raw = Object.hasOwn(doc.items, id) ? doc.items[id] : null;
		if (!raw || nativeViewpoint(JSON.parse(raw)).revision !== revision)
			throw new Error("Native viewpoint is missing or stale");
		delete doc.items[id];
	}, context);
	return { removed: true as const };
}
