/** @jsxImportSource @opentui/solid */
// The settings page as a list of rows, one line per setting, the way the
// original TUI presented it: the row states the effective value, activating it
// opens an editor under the row, and add/remove rows act on the local draft.
// Nothing here validates, previews, submits or approves; those stay explicit
// actions of the page shell.
import {
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
	useContext,
} from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { LocalChoiceContext } from "../../ui/LocalChoice.ts";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { color } from "../../ui/theme/index.ts";

const object = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const text = (value: unknown): string =>
	typeof value === "string" ? value : value === undefined ? "" : String(value);
const shown = (value: unknown): string => {
	const rendered = text(value);
	return rendered.length > 0 ? rendered : "(empty)";
};

/** Field edits, search, add and remove are local draft operations only: the
 * native preview stays the validation boundary and no ordinal is an identity. */
export function SettingsFields(props: {
	draft: string;
	change: (value: string) => void;
	editing: boolean;
	edit: (value: boolean) => void;
	connected: boolean;
}) {
	const [active, setActive] = createSignal<string | null>(null);
	const choices = useContext(LocalChoiceContext);
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const interactive = () =>
		!disposed && props.connected && (choices?.interactive() ?? true);
	const parsed = createMemo(() => {
		try {
			const value: unknown = JSON.parse(props.draft);
			return value && typeof value === "object" && !Array.isArray(value)
				? (value as Data)
				: null;
		} catch {
			return null;
		}
	});
	const list = (key: string): unknown[] =>
		Array.isArray(parsed()?.[key]) ? (parsed()?.[key] as unknown[]) : [];
	const indices = (key: string) =>
		Array.from({ length: list(key).length }, (_, index) => index);
	const mutate = (change: (draft: Data) => void) => {
		const draft = parsed();
		if (!draft || !interactive()) return;
		const next = structuredClone(draft);
		change(next);
		props.change(JSON.stringify(next, null, 2));
	};
	const open = (id: string) => {
		if (!interactive()) return;
		setActive(id);
		props.edit(true);
	};
	const isOpen = (id: string) => props.editing && active() === id;
	const close = () => {
		setActive(null);
		props.edit(false);
	};
	/** One setting row: the effective value on one line, its editor underneath. */
	const field = (
		parts: (string | number)[],
		label: string,
		detail: string,
		value: () => unknown,
		change: (value: string) => void,
		exists: () => boolean,
		maxLength = 4096,
	) => {
		const id = JSON.stringify(parts);
		return (
			<box flexDirection="column">
				<ActionHeader
					scope={[props.draft, active()]}
					interactive={interactive() && exists()}
					onActivate={() => open(id)}
				>
					<box flexDirection="row">
						<text fg={color("text")}>{label}</text>
						<text fg={color("textMuted")}> — </text>
						<text fg={color("primary")}>{shown(value())}</text>
					</box>
				</ActionHeader>
				<Show when={isOpen(id)}>
					<input
						value={text(value())}
						maxLength={maxLength}
						focused={isOpen(id)}
						onInput={(input) => {
							if (!isOpen(id) || input === value() || !exists()) return;
							change(input);
						}}
						onSubmit={close}
					/>
					<text fg={color("textMuted")}>{detail}</text>
				</Show>
			</box>
		);
	};
	const section = (title: string) => <text fg={color("primary")}>{title}</text>;
	const action = (
		label: string,
		run: () => void,
		options?: { warning?: boolean; enabled?: boolean },
	) => (
		<ActionHeader
			scope={[props.draft, active()]}
			interactive={
				(options?.enabled ?? true) &&
				(interactive() || options?.warning === true)
			}
			onActivate={run}
		>
			<text fg={color(options?.warning ? "warning" : "accent")}>{label}</text>
		</ActionHeader>
	);
	return (
		<box flexDirection="column">
			<Show when={!parsed()}>
				<text fg={color("warning")}>
					The draft is not a JSON object. Fix it in Advanced before editing
					fields.
				</text>
			</Show>
			<Show when={parsed()}>
				{section("Orchestrator")}
				{field(
					["default"],
					"Default profile",
					"Names a profile below",
					() => parsed()?.orchestratorProfile,
					(value) =>
						mutate((draft) => {
							draft.orchestratorProfile = value;
						}),
					() => parsed() !== null,
					128,
				)}
				{section(
					`Profiles · ${Object.keys(object(parsed()?.profiles)).length}`,
				)}
				<For each={Object.keys(object(parsed()?.profiles))}>
					{(id) => (
						<box flexDirection="column">
							<ActionHeader
								scope={[props.draft, active()]}
								interactive={interactive()}
								onActivate={() => open(`profile:${id}`)}
							>
								<box flexDirection="row">
									<text fg={color("text")}>{id}</text>
									<text fg={color("textMuted")}> — </text>
									<text fg={color("primary")}>
										{shown(object(object(parsed()?.profiles)[id]).model)}
									</text>
									<text fg={color("textMuted")}>
										{" · "}
										{shown(object(object(parsed()?.profiles)[id]).thinking)}
									</text>
								</box>
							</ActionHeader>
							<Show when={isOpen(`profile:${id}`)}>
								<For each={["model", "thinking", "description"]}>
									{(key) =>
										field(
											["profiles", id, key],
											`  ${key}`,
											key === "thinking"
												? "off · minimal · low · medium · high · xhigh"
												: key === "model"
													? "provider/model as the provider names it"
													: "Shown beside the profile",
											() => object(object(parsed()?.profiles)[id])[key],
											(value) =>
												mutate((draft) => {
													const profiles = object(draft.profiles);
													if (!Object.hasOwn(profiles, id)) return;
													const record = object(profiles[id]);
													record[key] = value;
													profiles[id] = record;
													draft.profiles = profiles;
												}),
											() => Object.hasOwn(object(parsed()?.profiles), id),
											key === "description" ? 2048 : 256,
										)
									}
								</For>
								{action(
									`Remove profile ${id}`,
									() => {
										close();
										mutate((draft) => {
											delete object(draft.profiles)[id];
										});
									},
									{ warning: true },
								)}
							</Show>
						</box>
					)}
				</For>
				{action("Add profile", () =>
					mutate((draft) => {
						const profiles = object(draft.profiles);
						let id = "new-profile",
							index = 1;
						while (Object.hasOwn(profiles, id)) id = `new-profile-${index++}`;
						profiles[id] = { model: "", thinking: "off", description: "" };
						draft.profiles = profiles;
					}),
				)}
				{section(`Repositories · ${list("repositories").length}`)}
				<For each={indices("repositories")}>
					{(index) => (
						<box flexDirection="column">
							<ActionHeader
								scope={[props.draft, active()]}
								interactive={interactive()}
								onActivate={() => open(`repository:${index}`)}
							>
								<box flexDirection="row">
									<text fg={color("text")}>Repository</text>
									<text fg={color("textMuted")}> — </text>
									<text fg={color("primary")}>
										{shown(list("repositories")[index])}
									</text>
								</box>
							</ActionHeader>
							<Show when={isOpen(`repository:${index}`)}>
								{field(
									["repositories", index],
									"  Path",
									"Absolute path on the host",
									() => list("repositories")[index],
									(value) =>
										mutate((draft) => {
											if (
												Array.isArray(draft.repositories) &&
												index < draft.repositories.length
											)
												draft.repositories[index] = value;
										}),
									() => index < list("repositories").length,
								)}
								{action(
									"Remove repository",
									() => {
										close();
										mutate((draft) => {
											if (Array.isArray(draft.repositories))
												draft.repositories.splice(index, 1);
										});
									},
									{ warning: true },
								)}
							</Show>
						</box>
					)}
				</For>
				{action("Add repository", () =>
					mutate((draft) => {
						draft.repositories = [
							...(Array.isArray(draft.repositories) ? draft.repositories : []),
							"",
						];
					}),
				)}
				{section(`Providers · ${list("providers").length}`)}
				<For each={indices("providers")}>
					{(index) => (
						<box flexDirection="column">
							<ActionHeader
								scope={[props.draft, active()]}
								interactive={interactive()}
								onActivate={() => open(`provider:${index}`)}
							>
								<box flexDirection="row">
									<text fg={color("text")}>
										{shown(object(list("providers")[index]).name)}
									</text>
									<text fg={color("textMuted")}> — </text>
									<text fg={color("primary")}>
										{shown(object(list("providers")[index]).type)}
									</text>
									<text fg={color("textMuted")}>
										{" · "}
										{shown(object(list("providers")[index]).baseUrl)}
									</text>
								</box>
							</ActionHeader>
							<Show when={isOpen(`provider:${index}`)}>
								<For each={["name", "type", "baseUrl", "username", "tokenRef"]}>
									{(key) =>
										field(
											["providers", index, key],
											`  ${key}`,
											key === "type"
												? "github · gitlab"
												: key === "baseUrl"
													? "HTTPS; HTTP only on loopback"
													: key === "tokenRef"
														? "Name of an environment variable, never the token"
														: "",
											() => object(list("providers")[index])[key],
											(value) =>
												mutate((draft) => {
													if (
														!Array.isArray(draft.providers) ||
														index >= draft.providers.length
													)
														return;
													const provider = object(draft.providers[index]);
													if (!value && ["username", "tokenRef"].includes(key))
														delete provider[key];
													else provider[key] = value;
													draft.providers[index] = provider;
												}),
											() => index < list("providers").length,
											2048,
										)
									}
								</For>
								{action(
									"Remove provider",
									() => {
										close();
										mutate((draft) => {
											if (Array.isArray(draft.providers))
												draft.providers.splice(index, 1);
										});
									},
									{ warning: true },
								)}
							</Show>
						</box>
					)}
				</For>
				{action("Add provider", () =>
					mutate((draft) => {
						draft.providers = [
							...(Array.isArray(draft.providers) ? draft.providers : []),
							{
								name: "new-provider",
								type: "gitlab",
								baseUrl: "https://gitlab.com",
							},
						];
					}),
				)}
			</Show>
		</box>
	);
}

/** The exact local draft as JSON, for reading the whole document at once. */
export function SettingsDraftJson(props: { draft: string; scope: unknown }) {
	const [open, setOpen] = createSignal(false);
	return (
		<box flexDirection="column">
			<ActionHeader
				scope={[props.scope, open()]}
				onActivate={() => setOpen((value) => !value)}
			>
				<text fg={color("accent")}>{open() ? "▾" : "▸"} Draft as JSON</text>
			</ActionHeader>
			<Show when={open()}>
				<SuppliedObservation
					value={props.draft}
					filetype="json"
					scope={props.scope}
					label="Local draft"
				/>
			</Show>
		</box>
	);
}
