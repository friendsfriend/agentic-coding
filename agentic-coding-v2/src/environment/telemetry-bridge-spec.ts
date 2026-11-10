// Public source-format fingerprint only; no legacy runtime import or receiver.
export const legacyCollectorConfigDigest =
	"2e1907bc7430a4174f19505fdd414c3f8b6232ed3d02f0b1815ea4a3ae3c7d7e";
export const collectorTelemetry = Object.freeze({
	protocol: "otlp-http-json",
	listen: "0.0.0.0:0",
	collectorService: "otel-collector",
	transport: "tls-host-gateway-v1",
} as const);
