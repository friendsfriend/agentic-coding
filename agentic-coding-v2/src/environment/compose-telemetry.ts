import type { ComposePlan, Target } from "./model.ts";
/** Static, pre-review selection. The exporter config/CA mount come only from
 * the original live receiver, never literal source, a reference or saved input. */
export function checkComposeTelemetry(
	target: Pick<Target, "telemetry" | "compose">,
	plan: ComposePlan,
) {
	const telemetry = target.telemetry;
	if (!telemetry || !("collectorService" in telemetry)) return;
	if (target.compose?.network === "isolated")
		throw new Error(
			"Native Compose telemetry requires its original owned bridge network",
		);
	const service = plan.services.find(
			(value) => value.id === telemetry.collectorService,
		),
		container = service?.container;
	if (
		!service ||
		!container ||
		container.image !== "otel/opentelemetry-collector-contrib:0.162.0" ||
		JSON.stringify(container.command) !==
			JSON.stringify(["--config=env:OTEL_COLLECTOR_CONFIG"]) ||
		container.entrypoint ||
		container.completion ||
		container.ports.length ||
		container.extraHosts?.["host.docker.internal"] !== "host-gateway" ||
		[
			...Object.keys(service.environment),
			...Object.keys(service.secretRefs ?? {}),
		].some((key) => key.startsWith("OTEL_") || key.startsWith("AC_OTEL_")) ||
		[...container.mounts, ...(service.volumeMounts ?? [])].some(
			(mount) =>
				mount.target === "/" ||
				mount.target === "/acv2-otel-ca.pem" ||
				mount.target.startsWith("/acv2-otel-ca.pem/"),
		)
	)
		throw new Error(
			"Native TLS telemetry requires an unexposed exact collector-v1 service, explicit host gateway and no reserved environment or CA mount override",
		);
}
