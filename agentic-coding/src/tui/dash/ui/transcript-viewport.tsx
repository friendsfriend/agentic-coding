/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import {
	createContext,
	createEffect,
	createMemo,
	createSignal,
	type JSX,
	onCleanup,
	onMount,
	Show,
	useContext,
} from "solid-js";

interface TranscriptViewport {
	box: ScrollBoxRenderable | undefined;
	observe(
		check: () => void,
		node?: () => BoxRenderable | undefined,
	): () => void;
	sample(): void;
}
export const TranscriptViewportContext = createContext<TranscriptViewport>();

/** One existing renderer-frame hook samples all lazy bodies. No timers or
 * perpetual reactive frame counter: an idle transcript remains idle. */
export function createTranscriptViewport(): TranscriptViewport {
	const observers = new Map<
		() => void,
		(() => BoxRenderable | undefined) | undefined
	>();
	let anchor: { node: BoxRenderable; y: number } | undefined;
	let previous:
		| { box: ScrollBoxRenderable; top: number; width: number; bottom: boolean }
		| undefined;
	return {
		box: undefined,
		observe(check, node) {
			observers.set(check, node);
			return () => {
				observers.delete(check);
			};
		},
		sample() {
			const box = this.box;
			if (!box) return;
			// Refined offscreen heights must not move text the reader is looking at.
			// Native sticky-bottom and explicit scrolling already handle themselves.
			if (
				anchor &&
				!anchor.node.isDestroyed &&
				previous?.box === box &&
				previous.top === box.scrollTop &&
				previous.width === box.viewport.width &&
				!previous.bottom
			) {
				const moved = anchor.node.screenY - anchor.y;
				if (moved !== 0) {
					box.scrollTop += moved;
					previous.top = box.scrollTop;
					return;
				}
			}
			const top = box.viewport.screenY;
			const bottom = top + box.viewport.height;
			let after: BoxRenderable | undefined;
			let crossing: BoxRenderable | undefined;
			for (const get of observers.values()) {
				const node = get?.();
				if (!node || node.isDestroyed || node.height <= 0) continue;
				if (
					node.screenY >= top &&
					node.screenY < bottom &&
					(!after ||
						node.screenY < after.screenY ||
						(node.screenY === after.screenY && node.height < after.height))
				)
					after = node;
				if (
					node.screenY < top &&
					node.screenY + node.height > top &&
					(!crossing || node.screenY > crossing.screenY)
				)
					crossing = node;
			}
			const node = after ?? crossing;
			anchor = node ? { node, y: node.screenY } : undefined;
			previous = {
				box,
				top: box.scrollTop,
				width: box.viewport.width,
				bottom:
					box.scrollTop >= Math.max(0, box.scrollHeight - box.viewport.height),
			};
			for (const check of observers.keys()) check();
		},
	};
}

export function estimateTextRows(text: string, width: number): number {
	const columns = Math.max(1, Math.floor(width));
	return text
		.split("\n")
		.reduce(
			(rows, line) =>
				rows +
				Math.max(
					1,
					Math.ceil(
						Bun.stringWidth(
							line.includes("\t") ? line.replaceAll("\t", "    ") : line,
						) / columns,
					),
				),
			0,
		);
}

export function estimateDiffRows(diff: string, width: number): number {
	const split = width > 120;
	const columns = Math.max(1, Math.floor(split ? width / 2 : width) - 6);
	let rows = 0;
	let hunk = false;
	let removed: string[] = [];
	let added: string[] = [];
	const flush = () => {
		if (split)
			for (
				let index = 0;
				index < Math.max(removed.length, added.length);
				index++
			)
				rows += Math.max(
					estimateTextRows(removed[index] ?? "", columns),
					estimateTextRows(added[index] ?? "", columns),
				);
		else
			for (const line of [...removed, ...added])
				rows += estimateTextRows(line, columns);
		removed = [];
		added = [];
	};
	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) {
			flush();
			hunk = true;
			continue;
		}
		if (line.startsWith("diff ") || line.startsWith("Index:")) {
			flush();
			hunk = false;
			continue;
		}
		if (!hunk) continue;
		if (line.startsWith("-")) removed.push(line.slice(1));
		else if (line.startsWith("+")) added.push(line.slice(1));
		else if (line.startsWith(" ")) {
			flush();
			rows += estimateTextRows(line.slice(1), columns);
		}
	}
	flush();
	return Math.max(1, rows);
}

/** Preserve the full scroll extent while mounting only nearby heavy bodies.
 * Measured heights replace estimates and are retained when a body leaves the
 * viewport. Overscan prepares content before wheel scrolling exposes it. */
export function VirtualToolBody(props: {
	children: JSX.Element;
	estimateHeight: (width: number) => number;
	cacheKey: unknown;
	force?: boolean;
	minRows?: number;
}) {
	const viewport = useContext(TranscriptViewportContext);
	if (!viewport) return props.children;
	let node: BoxRenderable | undefined;
	const [width, setWidth] = createSignal(80);
	const [visible, setVisible] = createSignal(false);
	const [measured, setMeasured] = createSignal<number>();
	const heights = new Map<number, number>();
	const estimated = createMemo(() =>
		Math.max(1, Math.ceil(props.estimateHeight(width()))),
	);
	const virtual = () => props.force || estimated() > (props.minRows ?? 40);
	const mounted = () => !virtual() || visible();
	createEffect(() => {
		void props.cacheKey;
		heights.clear();
		setMeasured(undefined);
	});
	const check = () => {
		const box = viewport.box;
		if (
			!node ||
			node.isDestroyed ||
			!box ||
			node.width <= 0 ||
			box.viewport.height <= 0
		)
			return;
		const columns = Math.max(1, Math.floor(node.width));
		if (columns !== width()) {
			setWidth(columns);
			setMeasured(heights.get(columns));
		}
		if (mounted() && node.height > 0) {
			const height = node.height;
			heights.set(columns, height);
			if (heights.size > 8)
				heights.delete(heights.keys().next().value ?? columns);
			if (measured() !== height) setMeasured(height);
		}
		const margin = Math.max(12, Math.ceil(box.viewport.height / 2));
		const near =
			node.screenY + node.height >= box.viewport.screenY - margin &&
			node.screenY <= box.viewport.screenY + box.viewport.height + margin;
		if (near !== visible()) setVisible(near);
	};
	onMount(() => {
		const stop = viewport.observe(check, () => node);
		onCleanup(stop);
		check();
	});
	return (
		<box
			ref={(value) => {
				node = value;
			}}
			flexDirection="column"
			flexShrink={0}
			width="100%"
			height={mounted() ? undefined : (measured() ?? estimated())}
		>
			<Show when={mounted()}>{props.children}</Show>
		</box>
	);
}
