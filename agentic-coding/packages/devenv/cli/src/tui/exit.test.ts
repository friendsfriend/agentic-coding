import { afterEach, describe, expect, test } from "bun:test";
import {
	__resetExitForTests,
	confirmExitApp,
	exitApp,
	registerExitGuard,
	registerGracefulShutdownHandler,
	setExitRenderer,
} from "./exit";

afterEach(() => {
	__resetExitForTests();
});

describe("exitApp", () => {
	test("uses fallback destroy when no graceful handler is registered", async () => {
		let destroyed = 0;
		setExitRenderer({
			destroy: () => {
				destroyed += 1;
			},
		});

		await exitApp();

		expect(destroyed).toBe(1);
		expect(process.exitCode).toBe(0);
	});

	test("blocks graceful shutdown when exit guard rejects", async () => {
		let runs = 0;
		registerExitGuard(() => false);
		registerGracefulShutdownHandler(() => {
			runs += 1;
		});

		await exitApp();

		expect(runs).toBe(0);
	});

	test("confirmed exit bypasses guard", async () => {
		let runs = 0;
		registerExitGuard(() => false);
		registerGracefulShutdownHandler(() => {
			runs += 1;
		});

		await confirmExitApp();

		expect(runs).toBe(1);
	});

	test("runs registered graceful shutdown once for duplicate exits", async () => {
		let runs = 0;
		let resolveShutdown!: () => void;
		const shutdown = new Promise<void>((resolve) => {
			resolveShutdown = resolve;
		});
		registerGracefulShutdownHandler(async () => {
			runs += 1;
			await shutdown;
		});

		const first = exitApp();
		const second = exitApp();
		resolveShutdown();
		await Promise.all([first, second]);

		expect(runs).toBe(1);
	});
});
