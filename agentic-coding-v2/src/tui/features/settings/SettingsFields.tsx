/** @jsxImportSource @opentui/solid */
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
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";

const object = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
/** Field edits/search/add/remove are local draft operations ONLY. Native preview
 * is the validation boundary; array ordinals are never native identities. */
export function SettingsFields(props: {
	draft: string;
	change: (value: string) => void;
	editing: boolean;
	edit: (value: boolean) => void;
	connected: boolean;
}) {
	const [active, setActive] = createSignal<string | null>(null),
		[ownedSource, setOwnedSource] = createSignal<string | null>(null),
		[selection, setSelection] = createSignal<{
			collection: string;
			key: string | number;
		} | null>(null),
		[raw, setRaw] = createSignal(false);
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
	const selected = (collection: string, key: string | number) =>
		selection()?.collection === collection && selection()?.key === key;
	const field = (
		parts: (string | number)[],
		label: string,
		value: () => unknown,
		change: (value: string) => void,
		exists: () => boolean,
		maxLength = 4096,
	) => {
		const id = JSON.stringify(parts);
		let retired = false;
		onCleanup(() => {
			retired = true;
		});
		const enter = () => {
			if (retired || !interactive() || !exists()) return;
			setActive(id);
			setOwnedSource(props.draft);
			setSelection(
				parts.length > 1
					? { collection: String(parts[0]), key: parts[1] ?? "" }
					: null,
			);
			props.edit(true);
		};
		const editing = () =>
			!retired &&
			interactive() &&
			exists() &&
			props.editing &&
			active() === id &&
			ownedSource() === props.draft;
		return (
			<box flexDirection="column">
				<ActionHeader
					scope={props.draft}
					interactive={interactive() && exists()}
					onActivate={enter}
				>
					<text fg={color("accent")}>{label} · edit draft field</text>
				</ActionHeader>
				<Show when={value() !== undefined && typeof value() !== "string"}>
					<text fg={color("warning")}>
						Supplied field is not text. Blank input does not replace it; only an
						explicit edit converts it. Inspect full draft below.
					</text>
				</Show>
				<input
					value={typeof value() === "string" ? String(value()) : ""}
					maxLength={maxLength}
					focused={editing()}
					onMouseDown={enter}
					onInput={(input) => {
						if (!editing() || input === value()) return;
						change(input);
						if (!retired && !disposed && exists()) setOwnedSource(props.draft);
					}}
					onSubmit={() => {
						if (editing()) props.edit(false);
					}}
				/>
			</box>
		);
	};
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Field-specific draft editor · no save/probe/live configuration update
			</text>
			<Show when={!parsed()}>
				<text fg={color("warning")}>
					Repair the JSON object in the advanced editor first. Only explicit
					native preview validates it.
				</text>
			</Show>
			<Show when={parsed()}>
				{field(
					["default"],
					"Default orchestrator profile ID (must name a configured draft profile)",
					() => parsed()?.orchestratorProfile,
					(value) =>
						mutate((draft) => {
							draft.orchestratorProfile = value;
						}),
					() => parsed() !== null,
					128,
				)}
				<text fg={color("primary")}>
					Profiles · explicit provider/model · thinking
					off/minimal/low/medium/high/xhigh
				</text>
				<SuppliedRecordWindow
					rows={Object.keys(object(parsed()?.profiles))}
					scope={props.draft}
					label="local draft profiles"
					title={(id) => id}
					search={(id) => JSON.stringify([id, object(parsed()?.profiles)[id]])}
					selected={(id) => selected("profiles", id)}
				>
					{(id) => (
						<box flexDirection="column" border={true} padding={1}>
							<text fg={color("textMuted")}>
								Profile {id} (rename in advanced JSON)
							</text>
							<For each={["model", "thinking", "description"]}>
								{(key) =>
									field(
										["profiles", id, key],
										key,
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
							<ActionHeader
								scope={props.draft}
								interactive={interactive()}
								onActivate={() =>
									mutate((draft) => {
										delete object(draft.profiles)[id];
									})
								}
							>
								<text fg={color("warning")}>
									Remove {id} from draft only (default must remain valid)
								</text>
							</ActionHeader>
						</box>
					)}
				</SuppliedRecordWindow>
				<ActionHeader
					scope={props.draft}
					interactive={interactive()}
					onActivate={() =>
						mutate((draft) => {
							const profiles = object(draft.profiles);
							let id = "new-profile",
								index = 1;
							while (Object.hasOwn(profiles, id)) id = `new-profile-${index++}`;
							profiles[id] = { model: "", thinking: "off", description: "" };
							draft.profiles = profiles;
						})
					}
				>
					<text fg={color("accent")}>
						Add blank draft profile (fill model before preview)
					</text>
				</ActionHeader>
				<text fg={color("primary")}>
					Repository allow-list · absolute canonical paths; no discovery/read on
					edit
				</text>
				<SuppliedRecordWindow
					rows={indices("repositories")}
					scope={props.draft}
					label="local repository draft rows"
					title={(index) =>
						`Repository ${index + 1} · ${String(list("repositories")[index])}`
					}
					search={(index) =>
						JSON.stringify(list("repositories")[index]) ?? "not supplied"
					}
					selected={(index) => selected("repositories", index)}
				>
					{(index) => (
						<box flexDirection="column">
							{field(
								["repositories", index],
								`Repository ${index + 1}`,
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
							<ActionHeader
								scope={props.draft}
								interactive={interactive()}
								onActivate={() =>
									mutate((draft) => {
										if (Array.isArray(draft.repositories))
											draft.repositories.splice(index, 1);
									})
								}
							>
								<text fg={color("warning")}>
									Remove repository from draft only
								</text>
							</ActionHeader>
						</box>
					)}
				</SuppliedRecordWindow>
				<ActionHeader
					scope={props.draft}
					interactive={interactive()}
					onActivate={() =>
						mutate((draft) => {
							draft.repositories = [
								...(Array.isArray(draft.repositories)
									? draft.repositories
									: []),
								"",
							];
						})
					}
				>
					<text fg={color("accent")}>Add blank repository draft row</text>
				</ActionHeader>
				<text fg={color("primary")}>
					Providers · github/gitlab · HTTPS (loopback HTTP exception) · tokenRef
					is an environment-variable NAME, never a token
				</text>
				<SuppliedRecordWindow
					rows={indices("providers")}
					scope={props.draft}
					label="local provider draft rows"
					title={(index) =>
						`${index + 1} · ${String(object(list("providers")[index]).name ?? "not supplied")}`
					}
					search={(index) =>
						JSON.stringify(list("providers")[index]) ?? "not supplied"
					}
					selected={(index) => selected("providers", index)}
				>
					{(index) => (
						<box flexDirection="column" border={true} padding={1}>
							<For each={["name", "type", "baseUrl", "username", "tokenRef"]}>
								{(key) =>
									field(
										["providers", index, key],
										key,
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
							<ActionHeader
								scope={props.draft}
								interactive={interactive()}
								onActivate={() =>
									mutate((draft) => {
										if (Array.isArray(draft.providers))
											draft.providers.splice(index, 1);
									})
								}
							>
								<text fg={color("warning")}>
									Remove provider from draft only
								</text>
							</ActionHeader>
						</box>
					)}
				</SuppliedRecordWindow>
				<ActionHeader
					scope={props.draft}
					interactive={interactive()}
					onActivate={() =>
						mutate((draft) => {
							draft.providers = [
								...(Array.isArray(draft.providers) ? draft.providers : []),
								{
									name: "new-provider",
									type: "gitlab",
									baseUrl: "https://gitlab.com",
								},
							];
						})
					}
				>
					<text fg={color("accent")}>
						Add provider draft row (no outbound call)
					</text>
				</ActionHeader>
				<ActionHeader
					scope={props.draft}
					onActivate={() => {
						if (!disposed) setRaw(!raw());
					}}
				>
					<text fg={color("accent")}>
						{raw() ? "▾" : "▸"} Inspect complete unvalidated local draft
						separately from native candidate
					</text>
				</ActionHeader>
				<Show when={raw()}>
					<SuppliedObservation
						value={props.draft}
						filetype="json"
						scope={props.draft}
						label="Exact local JSON draft; not validation or approval"
					/>
				</Show>
			</Show>
		</box>
	);
}
