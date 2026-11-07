/** @jsxImportSource @opentui/solid */
import type { SyntaxStyle } from "@opentui/core";
import { For, Show } from "solid-js";
import { color } from "../../ui/theme/index.ts";

/** Read-only transcript bytes, never a live file reader or an edit/apply action. */
export function FileContent(props: {
	path: string;
	content: string;
	syntax: SyntaxStyle;
	diff?: boolean;
	startLine?: number;
	label: string;
}) {
	const filetype = () => {
		const extension = props.path.split(".").at(-1)?.toLowerCase() ?? "";
		const languages: Record<string, string> = {
			ts: "typescript",
			tsx: "tsx",
			js: "javascript",
			jsx: "javascript",
			py: "python",
			rs: "rust",
			sh: "bash",
			json: "json",
			md: "markdown",
			yaml: "yaml",
			yml: "yaml",
			sql: "sql",
			go: "go",
			java: "java",
			css: "css",
			html: "html",
			c: "c",
			cpp: "cpp",
		};
		return languages[extension];
	};
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("textMuted")}>
				{props.label} · {props.path}
				{props.startLine === undefined
					? ""
					: ` · requested start line ${props.startLine}`}
			</text>
			<Show
				when={props.diff}
				fallback={
					<code
						content={props.content}
						filetype={filetype()}
						syntaxStyle={props.syntax}
						drawUnstyledText={true}
						wrapMode="word"
					/>
				}
			>
				<box flexDirection="column">
					<For each={props.content.split("\n")}>
						{(line) => (
							<text
								wrapMode="word"
								fg={
									line.startsWith("+++") ||
									line.startsWith("---") ||
									line.startsWith("@@")
										? color("textMuted")
										: line.startsWith("+")
											? color("success")
											: line.startsWith("-")
												? color("error")
												: color("text")
								}
							>
								{line || " "}
							</text>
						)}
					</For>
				</box>
			</Show>
		</box>
	);
}
