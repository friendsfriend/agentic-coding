/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, SyntaxStyle } from "@opentui/core";
import { createMemo, For, Show } from "solid-js";
import type { Data, ToolProgress } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { useHover } from "../../presentation/components/mouse/useHover.ts";
import { useTap } from "../../presentation/components/mouse/useTap.ts";
import { Spinner } from "../../presentation/components/Spinner.tsx";
import { uiColors } from "../../presentation/theme/colors.ts";
import { ImageView } from "../../ui/ImageView.tsx";
import { StructuredData } from "../../ui/StructuredData.tsx";
import { color } from "../../ui/theme/index.ts";
import { FileContent } from "./FileContent.tsx";
import { TranscriptHeader } from "./TranscriptHeader.tsx";

const object = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const string = (value: unknown) => (typeof value === "string" ? value : "");

/** Adapted file/shell cards and independently folded arguments/output/details.
 * Status comes from a paired retained result or a scoped native live slot.
 * An in-flight model call is explicitly not an execution observation. */
export function ToolCard(props: {
	identity: string;
	selected: boolean;
	select: (id: string) => void;
	anchor: (node: BoxRenderable | null) => void;
	call: Data;
	partial?: boolean;
	progress?: ToolProgress;
	liveOnly?: boolean;
	result: Data | null;
	pairing: "matched" | "missing" | "ambiguous";
	expanded: string[];
	toggle: (id: string) => void;
	syntax: SyntaxStyle;
}) {
	const hover = useHover();
	// Icon gutter from the original tool-call header; unknown tools keep its dot.
	const icons: Record<string, string> = {
		read: "→",
		write: "←",
		edit: "←",
		apply_patch: "←",
		patch: "←",
		glob: "✱",
		grep: "✱",
		find: "✱",
		bash: "$",
		shell: "$",
		execute: "▶",
		task: "✓",
		subagent: "✓",
		webfetch: "%",
		websearch: "◈",
		codemode: "{}",
		developer_question: "?",
		agent_ask: "?",
	};
	const args = () => object(props.call.arguments);
	const name = () => string(props.call.name) || "Unnamed native tool";
	const detailsValue = () =>
		props.result ? props.result.details : props.progress?.details;
	const details = () => object(props.result?.details);
	const output = () =>
		dataList(props.result?.content)
			.filter((part) => part.type === "text")
			.map((part) => string(part.text))
			.join("\n");
	const diagnostics = () =>
		props.result
			? dataList(props.result.nativeDiagnostics)
			: (props.progress?.diagnostics ?? []);
	const readOutput = () => {
		const parts = dataList(props.result?.content);
		const footer = `<harness>\n${diagnostics()
			.map((item) => `[${String(item.severity)}] ${string(item.message)}`)
			.join("\n")}\n</harness>`;
		// Remove only the exact separately recorded native diagnostic footer;
		// literal file bytes that resemble harness markup remain untouched.
		const body =
			diagnostics().length && parts.at(-1)?.text === footer
				? parts.slice(0, -1)
				: parts;
		return body
			.filter((part) => part.type === "text")
			.map((part) => string(part.text))
			.join("\n");
	};
	const path = () => string(args().path);
	const patch = () => string(details().patch) || string(details().diff);
	const open = (section = "") =>
		props.expanded.includes(`${props.identity}${section}`);
	const status = () =>
		props.partial
			? "Native in-flight call — still being generated, not execution status"
			: props.result
				? props.result.isError === true
					? "Native tool error"
					: "Result recorded"
				: props.progress
					? `Native slot ${props.progress.status}${props.progress.status === "running" ? " — may be waiting on owned work/review" : props.progress.status === "done" ? " — no terminal result linked" : ""}${props.progress.summary?.isError === true ? " · nested summary reports an error" : ""}`
					: props.pairing === "ambiguous"
						? "Ambiguous retained identity — output not paired"
						: "Result not in retained history — activity unknown";
	const summary = () =>
		["read", "edit", "write"].includes(name())
			? path()
			: name() === "bash"
				? string(args().command)
				: string(args().app) || string(args().title) || string(args().query);
	const structured = createMemo(() => {
		const text = dataList(props.result?.content).find(
			(part) => part.type === "text",
		)?.text;
		if (typeof text !== "string") return null;
		try {
			const parsed: unknown = JSON.parse(text);
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	});
	const specialized = () =>
		Boolean(
			path() &&
				(name() === "read" ||
					name() === "write" ||
					(name() === "edit" && patch())),
		) || name() === "bash";
	const fold = (suffix: string, label: string) => (
		<box
			{...useTap(
				() => {
					props.select(props.identity);
					props.toggle(`${props.identity}${suffix}`);
				},
				{ stopPropagation: true },
			)}
		>
			<text fg={color("accent")}>
				{open(suffix) ? "▾" : "▸"} {label}
			</text>
		</box>
	);
	return (
		<box
			flexDirection="column"
			paddingTop={1}
			paddingBottom={1}
			paddingLeft={2}
			paddingRight={1}
			flexShrink={0}
			border={["left"]}
			borderStyle="heavy"
			borderColor={
				props.result?.isError === true
					? color("error")
					: props.selected
						? color("primary")
						: props.result
							? color("success")
							: color("textMuted")
			}
			backgroundColor={hover.hovered() ? uiColors.bgHover : uiColors.bgMantle}
			{...hover}
		>
			<TranscriptHeader
				identity={props.identity}
				select={props.select}
				toggle={props.toggle}
				anchor={props.anchor}
			>
				<box flexDirection="row">
					<box
						width={name().startsWith("browser_") ? 3 : 2}
						flexShrink={0}
						flexDirection="row"
					>
						<Show when={name().startsWith("browser_")}>
							<text fg={color("textMuted")}>{"\uf488"}</text>
						</Show>
						<Show
							when={
								!props.partial &&
								!props.result &&
								props.progress?.status === "running"
							}
							fallback={
								<text
									fg={
										props.result?.isError === true
											? color("error")
											: color("textMuted")
									}
								>
									{icons[name()] ?? "•"}
								</text>
							}
						>
							<Spinner color={color("textMuted")} />
						</Show>
					</box>
					<text
						fg={props.result?.isError === true ? color("error") : color("text")}
						flexGrow={1}
						minWidth={0}
						wrapMode="word"
					>
						{name()}
						{summary() ? ` · ${summary()}` : ""}
					</text>
				</box>
				<text
					fg={
						props.result?.isError === true ? color("error") : color("textMuted")
					}
					wrapMode="word"
				>
					{status()}
					{typeof props.result?.durationMs === "number" &&
					Number.isFinite(props.result.durationMs)
						? ` · reported ${props.result.durationMs} ms`
						: ""}
				</text>
				<Show when={props.liveOnly}>
					<text fg={color("textMuted")}>
						{props.progress?.parentTaskId === undefined
							? "Unassociated current-round native slot; retained intent not linked"
							: `Native nested slot · parent task #${props.progress.parentTaskId} · parent call ${props.progress.parentCallId}`}{" "}
						{props.progress?.taskId === undefined
							? ""
							: `· task #${props.progress.taskId}`}
					</text>
				</Show>
			</TranscriptHeader>
			<Show when={open()}>
				<box flexDirection="column" gap={1} paddingTop={1}>
					<Show when={name() === "read" && path() && props.result}>
						<Show
							when={props.result?.isError !== true}
							fallback={
								<text fg={color("error")} wrapMode="word">
									{output()}
								</text>
							}
						>
							<FileContent
								path={path()}
								content={readOutput()}
								syntax={props.syntax}
								startLine={
									typeof args().offset === "number" ? Number(args().offset) : 1
								}
								label="Retained read output — not a live file snapshot"
							/>
						</Show>
					</Show>
					<Show when={name() === "write" && path()}>
						<FileContent
							path={path()}
							content={string(args().content)}
							syntax={props.syntax}
							label={
								props.partial
									? "Partial requested write bytes — call still being generated"
									: "Requested write bytes — not a live file snapshot"
							}
						/>
					</Show>
					<Show when={name() === "edit" && path() && patch()}>
						<FileContent
							path={path()}
							content={patch()}
							syntax={props.syntax}
							diff={true}
							label="Native retained edit diff"
						/>
					</Show>
					<Show when={name() === "edit" && !patch()}>
						<text fg={color("warning")}>
							No native diff retained. Requested replacements are available
							under Arguments; no applied diff is inferred.
						</text>
					</Show>
					<Show when={name() === "bash" && props.call.arguments !== undefined}>
						<text fg={color("textMuted")}>
							Requested shell command ·{" "}
							{args().timeout === undefined
								? "default timeout"
								: `timeout ${String(args().timeout)}`}
						</text>
						<code
							content={string(args().command)}
							filetype="bash"
							syntaxStyle={props.syntax}
							drawUnstyledText={true}
							wrapMode="word"
						/>
						<Show when={props.result}>
							<text wrapMode="word">
								{output() || "No text output retained."}
							</text>
						</Show>
					</Show>
					<Show when={!specialized() && props.result}>
						<Show
							when={structured() !== null}
							fallback={
								<text wrapMode="word">
									{output() || "No text output retained."}
								</text>
							}
						>
							<text fg={color("textMuted")}>
								Native structured output — status/authority fields are
								observations, not UI permissions.
							</text>
							<StructuredData
								value={structured()}
								label={`${name()} · retained native result`}
							/>
						</Show>
					</Show>
					<For each={diagnostics()}>
						{(item) => (
							<text
								wrapMode="word"
								fg={
									item.severity === "error"
										? color("error")
										: item.severity === "warn"
											? color("warning")
											: color("textMuted")
								}
							>
								Native {String(item.severity ?? "diagnostic")} ·{" "}
								{string(item.message)}
							</text>
						)}
					</For>
					{fold(
						":arguments",
						props.partial
							? "Partial arguments"
							: props.liveOnly
								? "Live slot arguments"
								: "Requested arguments",
					)}
					<Show when={open(":arguments")}>
						<Show
							when={props.call.arguments !== undefined}
							fallback={
								<text fg={color("textMuted")}>
									Arguments not present in this native live slot; inspect a
									retained request if available.
								</text>
							}
						>
							<code
								content={JSON.stringify(props.call.arguments, null, 2)}
								filetype="json"
								syntaxStyle={props.syntax}
								drawUnstyledText={true}
								wrapMode="word"
							/>
						</Show>
					</Show>
					<Show when={!props.result && props.progress?.output !== undefined}>
						{fold(
							":output",
							"Native bounded running output — not a terminal result",
						)}
						<text fg={color("textMuted")}>
							{props.progress?.droppedBytes === undefined
								? ""
								: `Native dropped bytes: ${props.progress.droppedBytes}`}
							{props.progress?.droppedLines === undefined
								? ""
								: ` · native dropped lines: ${props.progress.droppedLines}`}
						</text>
						<Show when={open(":output")}>
							<text wrapMode="word">{props.progress?.output}</text>
						</Show>
					</Show>
					<Show when={props.result}>
						{fold(":output", "Complete retained output")}
						<Show when={open(":output")}>
							<text wrapMode="word">
								{output() || "No text output retained."}
							</text>
						</Show>
						<For
							each={dataList(props.result?.content).filter(
								(part) => part.type !== "text",
							)}
						>
							{(part) => (
								<Show
									when={part.type === "image"}
									fallback={
										<text fg={color("textMuted")}>
											Retained {String(part.type ?? "non-text")} content ·{" "}
											{JSON.stringify(part)}
										</text>
									}
								>
									<ImageView
										content={part.data}
										mediaType={part.mimeType}
										caption="Retained native tool image"
									/>
								</Show>
							)}
						</For>
					</Show>
					<Show when={detailsValue() !== undefined}>
						{fold(
							":details",
							props.result ? "Native retained details" : "Native live details",
						)}
						<Show when={open(":details")}>
							<code
								content={JSON.stringify(detailsValue(), null, 2)}
								filetype="json"
								syntaxStyle={props.syntax}
								drawUnstyledText={true}
								wrapMode="word"
							/>
						</Show>
					</Show>
					<Show when={props.progress?.summary !== undefined && !props.result}>
						<text fg={color("textMuted")}>
							Native nested completion summary:{" "}
							{JSON.stringify(props.progress?.summary)}
						</text>
					</Show>
				</box>
			</Show>
		</box>
	);
}
