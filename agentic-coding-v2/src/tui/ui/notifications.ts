import { createSignal, onCleanup } from "solid-js";

export type LocalNotice = Readonly<{
	id: string;
	message: string;
	type: "info" | "success" | "warning" | "error";
	origin: string;
	receivedAt: number;
	truncated: boolean;
}>;
/** Per-mounted-client presentation state, never native receipts or authority.
 * Informational toasts expire; the bounded local archive remains readable. */
export function createNotifications(origin: () => string) {
	const [active, setActive] = createSignal<LocalNotice>();
	const [records, setRecords] = createSignal<readonly LocalNotice[]>([]);
	let sequence = 0;
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const clear = (expected?: LocalNotice) => {
		if (expected && active() !== expected) return;
		clearTimeout(timer);
		timer = undefined;
		setActive(undefined);
	};
	const publish = (
		message: string,
		type: LocalNotice["type"] = "info",
		source = origin(),
	) => {
		if (disposed) return undefined;
		clear();
		const truncated = message.length > 64000;
		const suffix =
			"\n[Local diagnostic display truncated; not a complete native source.]";
		let body = message.slice(0, truncated ? 64000 - suffix.length : 64000);
		if (truncated && /[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
		const item: LocalNotice = Object.freeze({
			id: String(++sequence),
			message: truncated ? body + suffix : body,
			type,
			origin: source,
			receivedAt: Date.now(),
			truncated,
		});
		setRecords((previous) => {
			const next = [...previous, item].slice(-32);
			let size = next.reduce((total, row) => total + row.message.length, 0);
			while (size > 128000 && next.length > 1)
				size -= next.shift()?.message.length ?? 0;
			return next;
		});
		setActive(item);
		timer = setTimeout(() => clear(item), 3000);
		return item;
	};
	onCleanup(() => {
		disposed = true;
		clear();
		setRecords([]);
	});
	return { active, records, publish, clear };
}
