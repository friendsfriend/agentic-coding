import { object, text } from "../config.ts";

type ProbeTiming = {
	initialDelaySeconds: number;
	periodSeconds: number;
	timeoutSeconds: number;
	successThreshold: number;
	failureThreshold: number;
};
export type ReadinessProbe = ProbeTiming &
	(
		| {
				httpGet: { path: string; port: number; scheme: "HTTP" | "HTTPS" };
				tcpSocket?: never;
		  }
		| { tcpSocket: { port: number }; httpGet?: never }
	);
function keys(data: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(data).some((key) => !allowed.includes(key)))
		throw new Error(
			"Unsupported readiness probe field; exec, gRPC, host overrides and headers are not supported",
		);
}
function integer(value: unknown, fallback: number, min: number, max: number) {
	const number = value ?? fallback;
	if (
		!Number.isSafeInteger(number) ||
		Number(number) < min ||
		Number(number) > max
	)
		throw new Error("Invalid bounded Kubernetes readiness probe number");
	return Number(number);
}
/** Only kubelet HTTP/TCP readiness against the pod itself; no extra exec authority. */
export function readReadinessProbe(raw: unknown): ReadinessProbe {
	const probe = object(raw);
	keys(probe, [
		"httpGet",
		"tcpSocket",
		"initialDelaySeconds",
		"periodSeconds",
		"timeoutSeconds",
		"successThreshold",
		"failureThreshold",
	]);
	if ((probe.httpGet === undefined) === (probe.tcpSocket === undefined))
		throw new Error("Choose exactly one HTTP or TCP readiness probe");
	const timing = {
		initialDelaySeconds: integer(probe.initialDelaySeconds, 0, 0, 300),
		periodSeconds: integer(probe.periodSeconds, 10, 1, 60),
		timeoutSeconds: integer(probe.timeoutSeconds, 1, 1, 30),
		successThreshold: integer(probe.successThreshold, 1, 1, 10),
		failureThreshold: integer(probe.failureThreshold, 3, 1, 10),
	};
	if (timing.timeoutSeconds > timing.periodSeconds)
		throw new Error("Readiness timeout must not exceed its period");
	if (probe.httpGet !== undefined) {
		const http = object(probe.httpGet);
		keys(http, ["path", "port", "scheme"]);
		const path = text(http.path ?? "/", "HTTP readiness path", 2048),
			scheme = http.scheme ?? "HTTP";
		if (
			!path.startsWith("/") ||
			path.startsWith("//") ||
			[...path].some(
				(char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
			) ||
			path.includes("#") ||
			(scheme !== "HTTP" && scheme !== "HTTPS")
		)
			throw new Error(
				"HTTP readiness requires a bounded pod-relative path and HTTP/HTTPS scheme",
			);
		return {
			...timing,
			httpGet: { path, port: integer(http.port, 0, 1, 65535), scheme },
		};
	}
	const tcp = object(probe.tcpSocket);
	keys(tcp, ["port"]);
	return { ...timing, tcpSocket: { port: integer(tcp.port, 0, 1, 65535) } };
}
