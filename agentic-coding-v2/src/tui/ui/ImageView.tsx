/** @jsxImportSource @opentui/solid */
import { imageInfo } from "@opentui/core";
import { createMemo, createSignal, Show } from "solid-js";
import { color } from "./theme/index.ts";
/** Bytes only: no path/URL source, no remote fetch, no image content in viewpoints. */
export function ImageView(props: {
	content: unknown;
	mediaType: unknown;
	caption: string;
}) {
	const [error, setError] = createSignal<string | null>(null);
	const image = createMemo(() => {
		setError(null);
		try {
			if (
				typeof props.content !== "string" ||
				props.content.length > 512000 ||
				!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
					props.content,
				) ||
				!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
					String(props.mediaType),
				)
			)
				throw new Error("Unsupported or oversized retained image");
			const bytes = Uint8Array.from(atob(props.content), (character) =>
				character.charCodeAt(0),
			);
			const info = imageInfo(bytes);
			if (
				!info.width ||
				!info.height ||
				info.width > 4096 ||
				info.height > 4096 ||
				info.width * info.height > 4000000
			)
				throw new Error("Image exceeds bounded terminal dimensions");
			return { bytes, info, error: null };
		} catch (error) {
			return {
				bytes: null,
				info: null,
				error: error instanceof Error ? error.message : "Image decode refused",
			};
		}
	});
	return (
		<box flexDirection="column" gap={1}>
			<text wrapMode="word" fg={color("textMuted")}>
				{props.caption} · {String(props.mediaType)} ·{" "}
				{image().info
					? `${image().info?.width}×${image().info?.height}`
					: "dimensions unavailable"}
				. Native terminal protocol auto/fallback; pixels are display only, never
				permission or independent visual acceptance.
			</text>
			<Show when={image().bytes && !error()}>
				<image
					source={image().bytes ?? undefined}
					height={20}
					width="100%"
					fit="fit"
					protocol="auto"
					onError={(error) =>
						setError(
							error instanceof Error
								? error.message
								: "Terminal image display failed",
						)
					}
				/>
			</Show>
			<Show when={image().error || error()}>
				<text fg={color("warning")}>{image().error ?? error()}</text>
			</Show>
		</box>
	);
}
