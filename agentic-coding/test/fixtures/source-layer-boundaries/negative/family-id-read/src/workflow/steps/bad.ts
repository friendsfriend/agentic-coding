// Fixture: a repository-family id comparison outside the definitions catalog
// must fail (read-family-traits-instead-of-ids). Every rule shape the guard
// knows is planted here once.
const FUSION_FAMILIES = new Set(["openspec-fusion", "openspec-fusion-propose"]);

export function isFusion(definition: { id: string }): boolean {
	return FUSION_FAMILIES.has(definition.id);
}

export function isChangeFree(definitionId: string): boolean {
	return definitionId === "no-openspec" || definitionId === "solo";
}

export function fusionFamily(definitionId: string): boolean {
	return definitionId.startsWith("openspec-fusion");
}

export function closeOnly(definitionId: string): boolean {
	switch (definitionId) {
		case "rebase":
		case "verify":
			return true;
		default:
			return false;
	}
}
