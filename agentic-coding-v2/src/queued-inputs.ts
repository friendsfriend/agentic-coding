import type { Progress } from "./protocol/index.ts";

/** Read-only previews, never input placement or an optimistic second queue.
 * Bound the whole observation as well as each message; never send image bytes. */
export function queuedInputs(
	items: readonly {
		id: number;
		mode: "steer" | "followUp" | "write";
		content?: unknown;
	}[],
): Progress["inbox"] {
	let remaining = 32768;
	return items.map((item) => {
		const limit = Math.min(2048, remaining);
		let content = "";
		if (typeof item.content === "string")
			content = item.content.slice(0, limit + 1);
		else if (Array.isArray(item.content)) {
			for (const part of item.content) {
				if (!part || typeof part !== "object") continue;
				const text =
					part.type === "text" && typeof part.text === "string"
						? part.text
						: part.type === "image"
							? "[image]"
							: "[non-text content]";
				content += `${content ? "\n" : ""}${text.slice(0, limit + 1 - content.length)}`;
				if (content.length > limit) break;
			}
		}
		const truncated = content.length > limit;
		content = content.slice(0, limit);
		remaining -= content.length;
		return {
			id: Number(item.id),
			mode: item.mode,
			...(item.mode === "write" ? {} : { content, truncated }),
		};
	});
}
