// Integration service composition: provider credentials are resolved on the
// Bun side so no token ever crosses the private Git adapter boundary
// (`port-git-providers-and-ai-to-bun`, task 2.1).
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EnvironmentManager } from "../src/server/environment/manager.ts";
import { EnvironmentStateStore } from "../src/server/environment/state-store.ts";
import { ProviderStore } from "../src/server/integrations/provider-store.ts";
import {
	createIntegrationServices,
	credentialsFor,
} from "../src/server/integrations/services.ts";

function tempConfig(): { configDir: string; homeDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "integration-services-"));
	const configDir = path.join(root, "config");
	fs.mkdirSync(path.join(configDir, "apps", "definitions"), {
		recursive: true,
	});
	fs.mkdirSync(path.join(configDir, "providers"), { recursive: true });
	return { configDir, homeDir: path.join(root, "home") };
}

function writeProviders(configDir: string): void {
	fs.writeFileSync(
		path.join(configDir, "providers", "gh.json"),
		JSON.stringify({
			name: "gh",
			type: "github",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder in a provider definition file
			username: "${GH_USER}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder in a provider definition file
			token: "${GH}",
		}),
	);
	fs.writeFileSync(
		path.join(configDir, "providers", "gl.json"),
		JSON.stringify({
			name: "gl",
			type: "gitlab",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder in a provider definition file
			username: "${GL_USER}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder in a provider definition file
			token: "${GL}",
		}),
	);
	fs.writeFileSync(
		path.join(configDir, ".env"),
		"GH_USER=octo\nGH=github-token\nGL_USER=octo\nGL=gitlab-token\n",
	);
}

describe("integration service credentials", () => {
	test("an app that names a provider wins over host inference", () => {
		const { configDir, homeDir } = tempConfig();
		writeProviders(configDir);
		fs.writeFileSync(
			path.join(configDir, "apps", "definitions", "demo.json"),
			JSON.stringify({
				ident: "demo",
				displayName: "Demo",
				repositoryPath: "https://github.com/acme/devenv.git",
				provider: "gl",
			}),
		);
		const providers = new ProviderStore(
			path.join(configDir, "providers"),
			path.join(configDir, ".env"),
		);
		providers.load();
		const manager = new EnvironmentManager({ homeDir, configDir });
		manager.loadConfig();
		expect(
			credentialsFor(providers, manager, "https://github.com/acme/devenv.git"),
		).toEqual({ username: "octo", token: "gitlab-token" });
	});

	test("host inference keeps GitHub and GitLab credentials apart", () => {
		const { configDir, homeDir } = tempConfig();
		writeProviders(configDir);
		const providers = new ProviderStore(
			path.join(configDir, "providers"),
			path.join(configDir, ".env"),
		);
		providers.load();
		const manager = new EnvironmentManager({ homeDir, configDir });
		manager.loadConfig();
		expect(
			credentialsFor(providers, manager, "https://github.com/acme/devenv.git"),
		).toEqual({ username: "octo", token: "github-token" });
		expect(
			credentialsFor(
				providers,
				manager,
				"https://gitlab.example.com/acme/devenv.git",
			),
		).toEqual({ username: "octo", token: "gitlab-token" });
		// Go's rule is host-class based: any non-GitHub URL is offered the
		// GitLab credential, which is what makes a freshly pasted GitLab repo
		// clonable. Recorded as a deliberate parity decision in
		// docs/integration-port.md.
		expect(
			credentialsFor(providers, manager, "https://example.com/x.git"),
		).toEqual({ username: "octo", token: "gitlab-token" });
	});

	test("a provider with a token but no username resolves no credentials", () => {
		// Matches the Go rule: host inference needs both halves of a credential.
		const { configDir, homeDir } = tempConfig();
		fs.writeFileSync(
			path.join(configDir, "providers", "gh.json"),
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder in a provider definition file
			JSON.stringify({ name: "gh", type: "github", token: "${GH}" }),
		);
		fs.writeFileSync(path.join(configDir, ".env"), "GH=github-token\n");
		const providers = new ProviderStore(
			path.join(configDir, "providers"),
			path.join(configDir, ".env"),
		);
		providers.load();
		const manager = new EnvironmentManager({ homeDir, configDir });
		manager.loadConfig();
		expect(
			credentialsFor(providers, manager, "https://github.com/acme/devenv.git"),
		).toEqual({ username: "", token: "" });
	});

	test("a provider file with clear-text credentials never resolves a token", () => {
		const { configDir, homeDir } = tempConfig();
		fs.writeFileSync(
			path.join(configDir, "providers", "gh.json"),
			JSON.stringify({ name: "gh", type: "github", token: "clear-text" }),
		);
		const providers = new ProviderStore(
			path.join(configDir, "providers"),
			path.join(configDir, ".env"),
		);
		providers.load();
		expect(providers.invalidProviders()[0]?.reason).toBe(
			"clear-text-credentials",
		);
		const manager = new EnvironmentManager({ homeDir, configDir });
		manager.loadConfig();
		expect(
			credentialsFor(providers, manager, "https://github.com/acme/devenv.git"),
		).toEqual({ username: "", token: "" });
	});

	test("the composed services expose the catalog and a credential resolver", () => {
		const { configDir, homeDir } = tempConfig();
		writeProviders(configDir);
		const manager = new EnvironmentManager({ homeDir, configDir });
		manager.loadConfig();
		const services = createIntegrationServices({
			manager,
			state: EnvironmentStateStore.open(path.join(homeDir, "db")),
			configDir,
		});
		expect(services.apps.getApps()).toEqual([]);
		expect(services.git.credentialConfig("https://github.com/x/y.git")).toEqual(
			[
				`http.extraheader=Authorization: Basic ${Buffer.from("octo:github-token").toString("base64")}`,
			],
		);
		// The credential config is never part of a recorded command.
		const result = services.git.run(
			".",
			["status"],
			["http.extraheader=Authorization: Basic s3cret"],
		);
		expect(result.command.includes("s3cret")).toBe(false);
	});
});
