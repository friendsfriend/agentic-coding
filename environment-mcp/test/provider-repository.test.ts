import { expect, test } from "bun:test";
import { providerRepositoryMatches } from "../src/domain/provider-repository.ts";

const providers = [
	{
		name: "github-fixture",
		type: "github" as const,
		baseUrl: "https://api.github.com",
	},
	{
		name: "gitlab-fixture",
		type: "gitlab" as const,
		baseUrl: "https://git.eon-cds.de",
	},
];

test("provider repository matching handles GitHub and nested GitLab remotes", () => {
	expect(
		providerRepositoryMatches(providers, "git@github.com:org/repo.git"),
	).toEqual([
		{
			provider: "github-fixture",
			type: "github",
			reference: "org/repo",
			host: "github.com",
			url: "https://github.com/org/repo",
		},
	]);
	expect(
		providerRepositoryMatches(providers, "https://github.com/org/repo.git"),
	).toHaveLength(1);
	expect(
		providerRepositoryMatches(
			providers,
			"ssh://git@git.eon-cds.de/group/sub/repo.git",
		),
	).toEqual([
		{
			provider: "gitlab-fixture",
			type: "gitlab",
			reference: "group/sub/repo",
			host: "git.eon-cds.de",
			url: "https://git.eon-cds.de/group/sub/repo",
		},
	]);
	expect(
		providerRepositoryMatches(
			providers,
			"git@git.eon-cds.de:group/sub/repo.git",
		)[0]?.reference,
	).toBe("group/sub/repo");
	expect(
		providerRepositoryMatches(providers, "git@github.com:org/group/repo.git"),
	).toEqual([]);
	expect(
		providerRepositoryMatches(providers, "git@github.com:org/../repo.git"),
	).toEqual([]);
	expect(
		providerRepositoryMatches(
			providers,
			"https://example.invalid/org/repo.git",
		),
	).toEqual([]);
	expect(providerRepositoryMatches(providers, "/local/path")).toEqual([]);
});
