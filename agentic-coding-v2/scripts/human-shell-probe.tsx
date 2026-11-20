/** @jsxImportSource @opentui/solid */
// One disposable full-shell acceptance path over the real authenticated local
// boundary and native harness, with a faux provider. No live integrations.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "v2-human-shell-"));
const original = {
	HOME: process.env.HOME,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
Object.assign(process.env, {
	HOME: sandbox,
	XDG_CONFIG_HOME: path.join(sandbox, "config"),
	PI_CODING_AGENT_DIR: path.join(sandbox, "pi"),
});
const { testRender, useRenderer } = await import("@opentui/solid");
const { createDefaultOpenTuiKeymap } = await import("@opentui/keymap/opentui");
const { KeymapProvider } = await import("@opentui/keymap/solid");
const { App } = await import("../src/tui/shell/App.tsx");
const { serve } = await import("../src/server/index.ts");
const { ClientConnection } = await import("../src/tui/client/connection.ts");
const { createFixtures, eventually } = await import(
	"../test/fixtures/runtime.ts"
);
const { fauxAssistantMessage, fauxToolCall } = await import(
	"@earendil-works/pi-ai"
);
const fixtures = createFixtures();
const { app, config, fake } = await fixtures.fixture();
const questions = [
	{
		header: "Design",
		question: "Choose a design",
		options: [
			{
				label: "Small",
				description: "Minimal change",
				preview: "```ts\nconst small = true;\n```",
			},
			{ label: "Large", description: "Expanded scope" },
		],
	},
];
fake.setResponses([
	fauxAssistantMessage(fauxToolCall("ask_user_question", { questions }), {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage(
		fauxToolCall("request_review", { path: ".", title: "Shell review" }),
		{ stopReason: "toolUse" },
	),
	(transcript) => {
		assert(JSON.stringify(transcript.messages).includes("Small"));
		return fauxAssistantMessage(
			"Human feedback received in the requesting agent",
		);
	},
]);
const repository = config.repositories[0];
assert(repository);
fs.writeFileSync(
	path.join(repository, "change.ts"),
	"export const changed = true;\n",
);
const host = serve(app),
	client = new ClientConnection(host.client);
client.connect();
await eventually(
	async () => client.state,
	(value) => value !== null,
);
const logs: string[] = [];
const t = await testRender(
	() => {
		const renderer = useRenderer();
		const keymap = createDefaultOpenTuiKeymap(renderer);
		return (
			<KeymapProvider keymap={keymap}>
				<App
					client={client}
					quit={() => {
						throw new Error("Unexpected quit");
					}}
					initialRoute={{ page: "orchestrator", resource: String(app.home.id) }}
				/>
			</KeymapProvider>
		);
	},
	{ width: 170, height: 58, kittyKeyboard: true },
);
let lastFrame = "";
const sample = () => {
	try {
		lastFrame = t.captureCharFrame();
		return true;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"status" in error &&
			error.status === -13
		)
			return false;
		throw error;
	}
};
const frame = () => lastFrame;
const save = (label: string) => logs.push(`\n--- ${label} ---\n${frame()}`);
const visible = async (text: string) => {
	if (sample() && frame().includes(text)) return frame();
	await new Promise<void>((resolve, reject) => {
		let done = false;
		const finish = (error?: Error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			remove();
			t.renderer.off("frame", onFrame);
			error ? reject(error) : resolve();
		};
		const check = () => {
			if (done || t.renderer.isDestroyed) return;
			try {
				if (sample() && frame().includes(text)) finish();
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const onFrame = () => {
			setImmediate(check);
		};
		const remove = client.onChange(() => t.renderer.requestRender());
		const timer = setTimeout(() => {
			save(`Missing expected: ${text}`);
			finish(new Error(`Missing expected: ${text}\n${frame()}`));
		}, 3000);
		t.renderer.on("frame", onFrame);
		t.renderer.requestRender();
		check();
	});
	return frame();
};
const click = async (label: string) => {
	const rendered = await visible(label);
	const lines = rendered.split("\n");
	const y = lines.findIndex((line) => line.includes(label));
	await t.mockMouse.click((lines[y] ?? "").indexOf(label) + 2, y);
	t.renderer.requestRender();
};
const key = async (name: string, options: Record<string, boolean> = {}) => {
	if (name === "RETURN") t.mockInput.pressEnter(options);
	else t.mockInput.pressKey(name, options);
	t.renderer.requestRender();
};

try {
	await click("Orchestrator");
	await client.call("session.send", {
		id: Number(app.home.id),
		content: "Ask the human, then review the change",
		requestId: "native-shell-probe",
	});
	await visible("Focus questionnaire");
	save("full shell · requesting tool and pending jump");
	assert(frame().includes("Jump to requesting card"));
	assert(
		!frame().includes("Enter select"),
		"arrival does not take keyboard focus",
	);
	await click("Jump to requesting card");
	await visible("Alt+U input");
	await key("F1");
	await visible("Jump to pending human input");
	save("full shell help · pending jump catalog");
	await key("ESCAPE");
	await key("u", { meta: true });
	await visible("Focus questionnaire");
	await click("Focus questionnaire");
	await visible("Enter select");
	save("full shell · active question footer");
	await key("1");
	await key("TAB");
	await key("RETURN");
	await visible("Shell review");
	await click("Jump to requesting card");
	await visible("A change.ts");
	save("full shell · code review does not steal focus");
	await click("A change.ts");
	await visible("export const changed");
	save("full shell · reused diff modal");
	await key("ESCAPE");
	await visible("Approve review");
	await click("Approve review");
	await visible("Human response · approved");
	await click("Jump to latest");
	await visible("Human feedback received in the requesting agent");
	save("full shell · committed receipts and resumed agent");
	assert(!frame().includes("Awaiting you · durable human input"));
	console.log(
		"Full native shell probe passed: transcript anchoring, no focus steal, sticky jump and catalog/help, native diff, authenticated question/code submissions, folded receipts and native agent continuation.",
	);
} finally {
	if (process.env.HUMAN_UI_EVIDENCE_DIR) {
		fs.mkdirSync(process.env.HUMAN_UI_EVIDENCE_DIR, { recursive: true });
		fs.writeFileSync(
			path.join(process.env.HUMAN_UI_EVIDENCE_DIR, "native-shell.log"),
			logs.join("\n"),
		);
	}
	t.renderer.destroy();
	client.close();
	await host.stop();
	await fixtures.cleanup();
	for (const [key, value] of Object.entries(original)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(sandbox, { recursive: true, force: true });
}
