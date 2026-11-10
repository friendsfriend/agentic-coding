// Executable fixture, never a real container engine. Requests go to one isolated
// in-test engine so killing a CLI cannot strand a synthetic filesystem lock.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const endpoint = process.env.FIXTURE_ENGINE_SOCKET;
const args = process.argv.slice(2);
const uri = args[1];

if (
	!endpoint ||
	!uri?.startsWith("unix:///") ||
	(args[0] === "--host"
		? uri.slice("unix://".length)
		: fileURLToPath(uri.replace(/^unix:/, "file:"))) !== endpoint
)
	throw new Error("Missing isolated fixture engine");
if (
	args[2] === "create" &&
	process.env.OTEL_COLLECTOR_CONFIG &&
	process.env.FIXTURE_TELEMETRY_RECEIPT
) {
	fs.writeFileSync(
		process.env.FIXTURE_TELEMETRY_RECEIPT,
		JSON.stringify({
			configuration: JSON.parse(process.env.OTEL_COLLECTOR_CONFIG),
			mounts: args.flatMap((arg, index) =>
				arg === "--mount" ? [args[index + 1]] : [],
			),
		}),
		{ mode: 0o600 },
	);
}
const response = await fetch("http://fixture/", {
	unix: endpoint,
	method: "POST",
	headers: { "X-Fixture-PID": String(process.pid) },
	body: JSON.stringify(args),
});
const result = (await response.json()) as {
	stdout: string;
	stderr: string;
	exit: number;
	follow: boolean;
};
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr)
	process.stderr.write(`${result.stderr} ${process.env.SERVICE_TOKEN ?? ""}\n`);
if (result.follow) {
	// A real engine prefixes each streamed line with its own timestamp on request.
	const stream = (line: string) =>
		console.log(
			args.includes("--timestamps")
				? `${new Date().toISOString()} ${line}`
				: line,
		);
	if (process.env.LOG_LINE) stream(process.env.LOG_LINE);
	if (
		process.env.OTEL_COLLECTOR_CONFIG &&
		process.env.FIXTURE_TELEMETRY_RECEIPT
	)
		stream(`collector configuration ${process.env.OTEL_COLLECTOR_CONFIG}`);
	stream(`service log ${process.env.SERVICE_TOKEN ?? ""}`);
	// Bound orphaned fixture clients to this disposable engine, even after a host SIGKILL.
	setInterval(async () => {
		try {
			await fetch("http://fixture/", {
				unix: endpoint,
				method: "HEAD",
				signal: AbortSignal.timeout(500),
			});
		} catch {
			try {
				fs.writeFileSync(
					path.join(
						process.env.CONFIG_DIR ?? "",
						`fixture-client-${process.pid}.exited`,
					),
					"fixture engine closed\n",
				);
			} catch {
				/* The parent may already have removed its disposable directory. */
			}
			process.exit(0);
		}
	}, 100);
} else {
	if (result.stdout.startsWith("build")) {
		console.log(process.env.SERVICE_TOKEN ?? "");
		if (process.env.FIXTURE_BUILD_SECRETS_RECEIPT) {
			const secrets = Object.entries(process.env).filter(([key]) =>
				key.startsWith("ACV2_BUILD_SECRET_"),
			);
			fs.writeFileSync(
				process.env.FIXTURE_BUILD_SECRETS_RECEIPT,
				JSON.stringify(
					Object.fromEntries(
						secrets.map(([key, value]) => [
							key,
							createHash("sha256")
								.update(value ?? "")
								.digest("hex"),
						]),
					),
				),
			);
			for (const [, value] of secrets) {
				console.log(value);
				for (const line of (value ?? "").split("\n"))
					if (line.includes("="))
						console.log(line.slice(line.indexOf("=") + 1));
			}
		}
	}
	process.exit(result.exit);
}
