type ExitRenderer = { destroy(): void };
type GracefulShutdownHandler = () => void | Promise<void>;
type ExitGuard = () => boolean | Promise<boolean>;

let renderer: ExitRenderer | null = null;
let gracefulShutdownHandler: GracefulShutdownHandler | null = null;
let gracefulShutdownPromise: Promise<void> | null = null;
let exitGuard: ExitGuard | null = null;
let bypassExitGuard = false;
let abortController = new AbortController();

/** Get the shared abort signal used to cancel background work on exit. */
export function getExitSignal(): AbortSignal {
	return abortController.signal;
}

export function abortExitSignal() {
	if (!abortController.signal.aborted) abortController.abort();
}

export function setExitRenderer(r: ExitRenderer) {
	renderer = r;
}

export function destroyExitRenderer() {
	renderer?.destroy();
}

export function registerExitGuard(guard: ExitGuard) {
	exitGuard = guard;
	return () => {
		if (exitGuard === guard) exitGuard = null;
	};
}

export function registerGracefulShutdownHandler(
	handler: GracefulShutdownHandler,
) {
	gracefulShutdownHandler = handler;
	return () => {
		if (gracefulShutdownHandler === handler) gracefulShutdownHandler = null;
	};
}

function fallbackExit() {
	abortExitSignal();
	destroyExitRenderer();
}

export function exitApp(): Promise<void> {
	process.exitCode = 0;
	if (!gracefulShutdownHandler) {
		fallbackExit();
		return Promise.resolve();
	}
	if (!gracefulShutdownPromise) {
		gracefulShutdownPromise = Promise.resolve()
			.then(async () => {
				if (!bypassExitGuard && exitGuard && !(await exitGuard())) {
					gracefulShutdownPromise = null;
					return;
				}
				bypassExitGuard = false;
				await gracefulShutdownHandler?.();
			})
			.catch(() => fallbackExit());
	}
	return gracefulShutdownPromise;
}

export function confirmExitApp(): Promise<void> {
	bypassExitGuard = true;
	return exitApp();
}

export function immediateExitApp() {
	process.exitCode = 0;
	fallbackExit();
}

export function __resetExitForTests() {
	renderer = null;
	gracefulShutdownHandler = null;
	gracefulShutdownPromise = null;
	exitGuard = null;
	bypassExitGuard = false;
	abortController = new AbortController();
}
