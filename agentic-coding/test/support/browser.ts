// Test-only browser discovery. The Bun test sandbox points HOME at a temporary
// directory, while a developer machine's Playwright cache lives under the real
// user home. A focused replay test should not need a network download.
import fs from "node:fs";
import path from "node:path";

export function installedChromium(): string | undefined {
	const roots: string[] = [];
	const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
	if (configured !== undefined && configured !== "") roots.push(configured);
	try {
		for (const user of fs.readdirSync("/Users"))
			roots.push(path.join("/Users", user, "Library/Caches/ms-playwright"));
	} catch {
		// Non-macOS or a sandbox without /Users: fall through.
	}
	for (const root of roots) {
		if (!fs.existsSync(root)) continue;
		for (const name of fs.readdirSync(root).sort().reverse()) {
			if (!name.startsWith("chromium-")) continue;
			const candidates = [
				path.join(
					root,
					name,
					"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
				),
				path.join(
					root,
					name,
					"chrome-mac/Chromium.app/Contents/MacOS/Chromium",
				),
				path.join(root, name, "chrome-linux/chrome"),
			];
			for (const candidate of candidates)
				if (fs.existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}
