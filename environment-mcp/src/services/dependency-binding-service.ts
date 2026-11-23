import { createHash } from "node:crypto";
import {
	type ServerManifest,
	serverManifestSchema,
} from "../configuration/server-manifest.ts";
import {
	type ContainerInspection,
	type ContainerInspectionPort,
	DependencyBindingRefusal,
	matchBorrowedContainer,
} from "../domain/dependency-binding.ts";
import { decideDependencyUse } from "../domain/dependency-policy.ts";

export type PreparedDependencyBindings = Readonly<{
	digest: string;
	plan: string;
}>;

/** Bound by a trusted server scope. This is read-only preparation, not an
 * approval journal or issuance permit; no method can start or stop a resource. */
export function createDependencyBindingService(
	configuration: ServerManifest,
	repository: string,
	containers: ContainerInspectionPort,
) {
	const manifest = serverManifestSchema.parse(configuration);
	if (!manifest.repositories.includes(repository))
		throw new DependencyBindingRefusal("dependency-owner-unavailable");
	const preparations = new WeakMap<
		PreparedDependencyBindings,
		{ app: string; target: string }
	>();
	const prepare = async (
		appId: string,
		targetId: string,
		signal: AbortSignal,
	): Promise<PreparedDependencyBindings> => {
		signal.throwIfAborted();
		const app = manifest.apps.find(
			(app) => app.id === appId && app.repository === repository,
		);
		const target = app?.targets.find((target) => target.id === targetId);
		if (!target)
			throw new DependencyBindingRefusal("dependency-owner-unavailable");
		const dependencies = [];
		for (const requirement of target.dependsOn) {
			signal.throwIfAborted();
			const service = manifest.services.find(
				(service) => service.id === requirement.service,
			);
			const binding = service?.binding;
			if (!binding)
				throw new DependencyBindingRefusal("dependency-binding-required");
			// Owned dependencies require original handles from the future mutation
			// controller; a matching observation alone must never grant ownership.
			if (requirement.lifecycle === "owned")
				throw new DependencyBindingRefusal("dependency-owner-unavailable");
			let inspection: ContainerInspection;
			try {
				inspection = await containers.inspect(binding, signal);
			} catch {
				throw new DependencyBindingRefusal(
					"dependency-observation-unavailable",
				);
			}
			signal.throwIfAborted();
			if (inspection.status === "absent") {
				const decision = decideDependencyUse(requirement.lifecycle, {
					state: "absent",
				});
				throw new DependencyBindingRefusal(
					decision.action === "start"
						? "dependency-start-required"
						: "external-unavailable",
				);
			}
			const observation = matchBorrowedContainer(binding, inspection.document);
			const decision = decideDependencyUse(requirement.lifecycle, {
				state: observation.ready ? "ready" : "unready",
				identityMatches: true,
				ownedByController: false,
			});
			if (decision.action !== "reuse")
				throw new DependencyBindingRefusal("dependency-not-ready");
			dependencies.push({
				service: service.id,
				lifecycle: requirement.lifecycle,
				binding,
				identity: observation.identity,
				action: "reuse",
				cleanup: "never",
			});
		}
		const plan = JSON.stringify({
			app: appId,
			target: targetId,
			repository,
			dependencies,
		});
		const prepared = Object.freeze({
			plan,
			digest: createHash("sha256").update(plan).digest("hex"),
		});
		preparations.set(prepared, { app: appId, target: targetId });
		return prepared;
	};
	return {
		prepare,
		async revalidate(
			prepared: PreparedDependencyBindings,
			signal: AbortSignal,
		) {
			const request = preparations.get(prepared);
			if (!request)
				throw new DependencyBindingRefusal(
					"dependency-preparation-unavailable",
				);
			const current = await prepare(request.app, request.target, signal);
			if (current.plan !== prepared.plan)
				throw new DependencyBindingRefusal("dependency-generation-changed");
			// The original frozen bytes remain authoritative; never replace the
			// caller's review with the newly observed generation.
			return prepared;
		},
	};
}
