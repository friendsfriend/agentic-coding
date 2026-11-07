/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js";
import { ActionHeader } from "./ActionHeader.tsx";
import { color } from "./theme/index.ts";

type Row = {
	key: string;
	name: string;
	depth: number;
	branch: boolean;
	text: string;
};
/** Bounded read-only record explorer. Expansion never fetches files/resources,
 * submits commands or interprets authority fields as permissions. */
export function StructuredData(props: { value: unknown; label?: string }) {
	const [expanded, setExpanded] = createSignal<string[]>(["root"]);
	const rows = createMemo(() => {
		const output: Row[] = [];
		const visit = (
			value: unknown,
			key: string,
			name: string,
			depth: number,
		) => {
			if (output.length >= 512) return;
			const branch = value !== null && typeof value === "object";
			const children = branch ? Object.entries(value) : [];
			const text = branch
				? `${Array.isArray(value) ? "list" : "record"} · ${children.length} entries`
				: typeof value === "string"
					? value
					: (JSON.stringify(value) ?? "not recorded");
			output.push({
				key,
				name,
				depth,
				branch,
				text:
					text.length > 2000
						? `${text.slice(0, 2000)} … [display clipped]`
						: text,
			});
			if (branch && expanded().includes(key) && depth < 8)
				for (const [index, [name, child]] of children.entries()) {
					if (index >= 128 || output.length >= 512) break;
					visit(child, `${key}/${index}:${name}`, name, depth + 1);
				}
		};
		visit(props.value, "root", props.label ?? "Observed record", 0);
		return output;
	});
	return (
		<box flexDirection="column" gap={0}>
			<For each={rows()}>
				{(row) => (
					<box flexDirection="column" paddingLeft={row.depth * 2}>
						<Show
							when={row.branch}
							fallback={
								<text wrapMode="word">
									<span style={{ fg: color("textMuted") }}>{row.name}: </span>
									{row.text}
								</text>
							}
						>
							<ActionHeader
								onActivate={() =>
									setExpanded((keys) =>
										keys.includes(row.key)
											? keys.filter((key) => key !== row.key)
											: [...keys, row.key].slice(-256),
									)
								}
							>
								<text wrapMode="word" fg={color("accent")}>
									{expanded().includes(row.key) ? "▾" : "▸"} {row.name} ·{" "}
									{row.text}
									{row.depth >= 8 ? " · depth limit" : ""}
								</text>
							</ActionHeader>
						</Show>
					</box>
				)}
			</For>
			<text fg={color("textMuted")}>
				Read-only display · 512 rows / 128 children per branch / depth 8 / 2,000
				characters per value maximum. Clipping is presentation only, not
				evidence of completeness.
			</text>
		</box>
	);
}
