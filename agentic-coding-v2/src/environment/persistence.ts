export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { [key: string]: Json };
export type DocumentData = { [key: string]: Json };

export type EnvironmentOwner = {
	id: number;
	repository: string;
	workspace: string;
	kind?: "operator-environment";
};

/** Singleton data identity, independent of any agent runtime or storage engine. */
export type EnvironmentDocument<T extends DocumentData> = {
	readonly definition: {
		readonly kind: string;
		readonly version: number;
		readonly scope: "session";
		initial(): T;
	};
};

/** Also structurally usable by the legacy native adapter without changing stored identities. */
export function environmentDocument<T extends DocumentData>(definition: {
	kind: string;
	version: number;
	initial(): T;
}) {
	if (
		!definition.kind ||
		!Number.isSafeInteger(definition.version) ||
		definition.version < 1
	)
		throw new Error("Invalid environment document identity");
	return {
		definition: {
			...definition,
			scope: "session" as const,
			checkpointWhen: () => true,
		},
	};
}

export interface EnvironmentTransaction {
	doc<T extends DocumentData>(document: EnvironmentDocument<T>): Promise<T>;
	/** Evaluated on the same transaction line as reservations/issuance. */
	ownerActive(id: number): Promise<boolean>;
	ownerInfo(id: number): Promise<EnvironmentOwner | undefined>;
}

/** No process/network dispatch or nested transactions. One-way live revocation
 * latches may accompany durable intent and remain fail-closed if persistence fails. */
export interface EnvironmentPersistence {
	snapshot<T extends DocumentData>(
		document: EnvironmentDocument<T>,
		context?: unknown,
	): Promise<Readonly<T> | undefined>;
	commit<T>(
		operation: (tx: EnvironmentTransaction) => Promise<T>,
		context?: unknown,
	): Promise<T>;
}
