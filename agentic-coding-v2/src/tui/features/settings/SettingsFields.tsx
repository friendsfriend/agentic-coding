/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";

const object = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
/** Local draft conveniences only; native preview remains the sole validation/approval boundary. */
export function SettingsFields(props: {
	draft: string;
	change: (value: string) => void;
	editing: boolean;
	edit: (value: boolean) => void;
	connected: boolean;
}) {
	const [active, setActive] = createSignal<string | null>(null);
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
	const list = (key: string): unknown[] => {
		const value = parsed()?.[key];
		return Array.isArray(value) ? value : [];
	};
	const mutate = (change: (draft: Data) => void) => {
		const draft = parsed();
		if (!draft || !props.connected) return;
		const next = structuredClone(draft);
		change(next);
		props.change(JSON.stringify(next, null, 2));
	};
	const field = (
		id: string,
		label: string,
		value: () => unknown,
		change: (value: string) => void,
		maxLength = 4096,
	) => (
		<box flexDirection="column">
			<ActionHeader
				onActivate={() => {
					setActive(id);
					props.edit(true);
				}}
			>
				<text fg={color("accent")}>{label} · edit draft field</text>
			</ActionHeader>
			<input
				value={typeof value() === "string" ? String(value()) : ""}
				focused={props.editing && props.connected && active() === id}
				maxLength={maxLength}
				onMouseDown={() => {
					setActive(id);
					props.edit(true);
				}}
				onInput={(inputText) => {
					if (inputText !== value()) change(inputText);
				}}
				onSubmit={() => props.edit(false)}
			/>
		</box>
	);
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Field-specific draft editor · no save, probe or live configuration
				update
			</text>
			<Show when={!parsed()}>
				<text fg={color("warning")}>
					Repair the JSON object in the advanced editor first. Native validation
					occurs only on explicit preview.
				</text>
			</Show>
			<Show when={parsed()}>
				{field(
					"default",
					"Default orchestrator profile ID (must name a configured draft profile)",
					() => parsed()?.orchestratorProfile,
					(value) =>
						mutate((draft) => {
							draft.orchestratorProfile = value;
						}),
					128,
				)}
				<text fg={color("primary")}>
					Profiles · explicit provider/model · thinking
					off/minimal/low/medium/high/xhigh
				</text>
				<For each={Object.keys(object(parsed()?.profiles))}>
					{(id) => (
						<box flexDirection="column" border={true} padding={1}>
							<text fg={color("textMuted")}>
								Profile {id} (rename through advanced JSON)
							</text>
							<For each={["model", "thinking", "description"]}>
								{(key) =>
									field(
										`profile:${id}:${key}`,
										key,
										() => object(object(parsed()?.profiles)[id])[key],
										(value) =>
											mutate((draft) => {
												object(object(draft.profiles)[id])[key] = value;
											}),
										key === "description" ? 2048 : 256,
									)
								}
							</For>
							<ActionHeader
								onActivate={() =>
									mutate((draft) => {
										delete object(draft.profiles)[id];
									})
								}
							>
								<text fg={color("warning")}>
									Remove {id} from draft only (default must still be valid)
								</text>
							</ActionHeader>
						</box>
					)}
				</For>
				<ActionHeader
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
				<For
					each={
						Array.isArray(parsed()?.repositories)
							? Array.from(
									{ length: list("repositories").length },
									(_, index) => index,
								)
							: []
					}
				>
					{(index) => (
						<box flexDirection="column">
							{field(
								`repo:${index}`,
								`Repository ${index + 1}`,
								() => list("repositories")[index],
								(value) =>
									mutate((draft) => {
										if (Array.isArray(draft.repositories))
											draft.repositories[index] = value;
									}),
							)}
							<ActionHeader
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
				</For>
				<ActionHeader
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
					is an environment-variable NAME, never a credential value
				</text>
				<For
					each={
						Array.isArray(parsed()?.providers)
							? Array.from(
									{ length: list("providers").length },
									(_, index) => index,
								)
							: []
					}
				>
					{(index) => (
						<box flexDirection="column" border={true} padding={1}>
							<For each={["name", "type", "baseUrl", "username", "tokenRef"]}>
								{(key) =>
									field(
										`provider:${index}:${key}`,
										key,
										() => object(list("providers")[index])[key],
										(value) =>
											mutate((draft) => {
												if (!Array.isArray(draft.providers)) return;
												const provider = object(draft.providers[index]);
												if (!value && ["username", "tokenRef"].includes(key))
													delete provider[key];
												else provider[key] = value;
											}),
										2048,
									)
								}
							</For>
							<ActionHeader
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
				</For>
				<ActionHeader
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
			</Show>
		</box>
	);
}
