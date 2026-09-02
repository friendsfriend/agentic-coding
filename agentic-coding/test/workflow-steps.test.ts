import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rolesForDefinition } from "../src/workflow/cli.ts";
import type { WorkflowSnapshot } from "../src/workflow/contracts.ts";
import {
	BUILTIN_CAPABILITIES,
	BUILTIN_EFFECTS,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import {
	type StepDefinition,
	WorkflowRegistry,
} from "../src/workflow/registry.ts";
import { runtimeTest } from "../src/workflow/runtime.ts";
import {
	assertStepBehaviorCoverage,
	rolesForStep,
	stepBehavior,
} from "../src/workflow/steps/index.ts";

const EXPECTED_DEFINITIONS: Array<{
	id: string;
	version: number;
	digest: string;
	stepDigests: Readonly<Record<string, string>>;
}> = [
	{
		id: "openspec-full",
		version: 21,
		digest: "c00fd37ff89933dbbad65eefe02691647a8bf186a73275380132e5cb77d5a641",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 21,
		digest: "e06ed4554b3070e88241e905197ccfcfefb6005f059bae9f1fca5b7abfc4aaa2",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 21,
		digest: "921cae048064a9963a07c60f0a17bded9c7b3081a1b80b3fe69ef1677be7b0ea",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 21,
		digest: "7c1cd28d5276e2cbcb90cfb96bf187684e27a3db89389e5e7aa47e37b18d057f",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 21,
		digest: "ff77b3fbb1c34ab4714ded4c8c3ad3925bf884ee4884fb0ac013b0dedac9faae",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 21,
		digest: "5fb8d6ff8fb5356a49464a3a2c5792c597e8c23d5f8331e567496b4e816d9e36",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 101,
		digest: "3b7efc29020fdbe2103dd0c919542cfb3a89f3ca99b98c958f8d1ac4c140ec3b",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 101,
		digest: "1594ae157aa4792c07146a6f644cdea7d49445fe403404fa0b99090abf447bab",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 101,
		digest: "efc5d6e31c623478b5619f86da4714669f6531c625b2e84c10b21129f53531cc",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 101,
		digest: "85e46ba47ee4d1f9ab3960b10e0c8c27daa715428b9a1a21d903c5ef98a9649b",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 101,
		digest: "24d3daed50b437a891fd24fe5cb90b768a0f1dd73c83028e168dc99c0ed546e8",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 101,
		digest: "ebc7db1161edd86160225a091ea2e5ac4db53bb6fdfac3c24f2727aa5586d25c",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 101,
		digest: "2e2f7710493aab56077766c14e25e599786cf0cc3a4b695d6d8df36f986285ef",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 101,
		digest: "0a8cbc014526b209ef890161baa52240a3d1cbdd83dc93452688888a707a37ba",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 101,
		digest: "c48f24ec1e8888bf5a407f102c9ae54bc3e469624c6b69a6ee974f199f708995",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 2,
		digest: "da32ac2bb5b1425dcde20bb703ee97558a47482e351e81ec756774255ae33af4",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 2,
		digest: "c33ae47818d8eed415f38bb9dcbae2dbe6aaa6a86b4097189990555b7a4d3d8a",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 2,
		digest: "bb90a83bab188b46122d10fec425cc091dc85923e35be0009b36d2fbd010cdfc",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 2,
		digest: "3a2a6f579d9e5922c45d0880a1fc76159365a786e6c6065e746493388794ae98",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 2,
		digest: "ebc6a9312c4a2d890e2dc415772a151d39733ffdd8cb6952bc79714e9c7aa8e8",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 2,
		digest: "d33210ecd25b26c3e10c1298abd405d93aba102a2b895f15a25fb4f6c92dec7c",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 102,
		digest: "9d3f63d5c30bde60557ce67004a8555c4c9baf6c89d5beb72c9a393e27353b3a",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 102,
		digest: "536d25823073af46bca0c81ed55e38e9cece4ff217228a5451b34bc81a5147f8",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 102,
		digest: "59c6623a49915e41599a00ec6efbf9f6c0ea81ebbbc60dd3bf9413b4e957a1a8",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 102,
		digest: "7df3fc6a8662943d194cce3c0d2b5b93f964ea1b9a47b527886c55f4c0dacc5f",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 102,
		digest: "2addc5df14c4092acf42132dddb3cbb9416b095646c915419b520ca040d39a51",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 102,
		digest: "6f1accb023ccfdc35bcbf0a3836970b55045130033b17ea62fa7c20c92aaaddb",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 102,
		digest: "102a7d7bdbd24f5fb8b178bbd8653318de4a88ba3bc8fc7dc3f8275947f6603a",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 102,
		digest: "f93c0faea756f1e401b6fc45b8efb491377c3c51f2ce452db603cf11f499839c",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 102,
		digest: "33c83813d7b9e49667d3838014681176dc9c72480d19c1a59df4c1bab8e63352",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 3,
		digest: "a6e4bd64728856f2afede24f3d4138a9ab5a6da652d0845b0a67f48a3eccf135",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 3,
		digest: "5f4eaa9547729561138c442ecdc4c4f35a46727ff25d33ff4a22be301b3376fe",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 3,
		digest: "c85b0851d2147e66385226c7d36e9ebc51e62d94fe4a8d3342f0b6c32da2ebb4",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 3,
		digest: "18ac3fbf3a4ba11209df90d9dfe7a339fcdd6bb95fc45f68e557566a482e4d41",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 3,
		digest: "60694356d5ce9d922b2dcdb1839b83fc00571c5e6c97a621a7a30a686d284051",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 3,
		digest: "80eb5e49a1d010531f499d9aef2d9168a3f6cbd5221d4a996e9e06eaa2e572bb",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 103,
		digest: "3ca66682b3c84923c6bdff8889f4707bcc48a8ce1d3fb233424f7c4cdf665dda",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 103,
		digest: "18c418cd81e57d3f2caba5af90c5a5c0e4f4bc15ea5338583260409b504f66c4",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 103,
		digest: "834c862ca5a1ef46370042d41a3c8b8ce14509cb8ba613cc3f985fcfcbaeea19",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 103,
		digest: "44cd9deb3a12eec9eed037d4c247411598fd553f5816e4dfb84de59a6a2b0752",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 103,
		digest: "a226311e0697d08ed0370ead9c4c3757ea2fc4c7df25ff19893a77d602b88b7f",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 103,
		digest: "7489994e01919ef74fa979ba5323c9168548854018eca63ec1fe1b87a8f2bd7b",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 103,
		digest: "1a8f61b3c2d4397b9ece25d92e2ecbe153d2feb4e67ef0ab792a32fe9c5816b0",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 103,
		digest: "9334c7035408406fbf24524d19a3c8b16ddcee588dead1f6c8689b85a2168a00",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 103,
		digest: "ca6f8eeae57ea886d4f625439dd9141094ddb228867e16da7a6088277ba91cc7",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 4,
		digest: "e0b7b2d02720b4835376395340c26b202099afb9a137b3d1a7bb5d0b9801cfde",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 4,
		digest: "aa390c8bb8025ac35cd515cd2e6bbeab14b9e527d27bffc8fc042f74c39c65b7",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 4,
		digest: "ac21404f7dcf80b325acbb5c56e2f745b66c0571df300a00d7fbe47209978eba",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 4,
		digest: "8abf62b1adcb188f7ca626e7cf9bf29b7d693a2f686cb8dff39c29ba1badb31a",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 4,
		digest: "002605fade688e580579cfb014e111a41039df800985d76e846cc40502397c72",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 4,
		digest: "df8169e1ed6f3a1e836433fe05fcd5273c708d2fd2952a6f3c8e7a9bd06a43ed",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 104,
		digest: "7fd98312e4cc79c1d6dda463bbfcc86ab5c30c1e5030e7283a84069a44c5334e",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 104,
		digest: "4e79ba5714a76a214cbafa2e4b8609ca8a87dcecbc170695c7978822f318b692",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 104,
		digest: "b7be86927d31713555895b729e6469a79134b61d89e9106e9c493741b73e353b",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 104,
		digest: "3e81dbdf6b4549da4f03fb263706615b6586ece29ba8b8e0f9f39c06ad9098b9",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 104,
		digest: "2217c4386c66c7e44dfc09bfaa0e947312b6a9670b894ffba65cbb26d77e50ae",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 104,
		digest: "7ae1349c717088cfcfd75be677c37ff0a618ad23a87df02fa41f70a04e3798b0",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 104,
		digest: "7dfecc653237f056c5ede0ec59fcf37713ca60dd331849f063065980d3c371c7",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 104,
		digest: "96b7fb07629e28badea58eacb8f9ddf44c4f52a07c6ca87e87ddb5e3fa1387aa",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 104,
		digest: "06d4e871d579e479701194c51276fe01675f54a463a3b6da16ff79e49f345ed2",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 5,
		digest: "7132ab59cc99a0855108ac920eecdf0040b6d22e79ec6dcdb52bc2adf499a5d4",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 5,
		digest: "67d715a8d8af42e95f411af67de2827998405c0857e8bc61ee60393954f0f2e8",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 5,
		digest: "77fb476e94bd75a4da04edec603991cae5d880035a70263b971f5ac30f3c4fa3",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 5,
		digest: "c3f9fa8f7f3992a23841ac45327f130120e874748a37984df7b2b4cb5dc1ef29",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 5,
		digest: "f09d2a8c5550571c4c6583041ea7cad8e277a2709fb1835a2773b3bac63d2b2a",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 5,
		digest: "29df89350080e605733ef6b15c5693aee4ab96c444f98ebf73967af9a4bd11d0",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 105,
		digest: "a493f4e552da0839d370fa9681859904b8edbf2e9363508c1c572f64d7d00c51",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 105,
		digest: "f75bdce2f42f5fb522ce1f8472b8b5ea41ed4b9dfdbc111705bb3ab40508ab9c",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 105,
		digest: "ceeb45406e150ed2bcc061fde9083f2d3880fa74a9cded0fde288f33990c91c7",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 105,
		digest: "80cfb940b9924f60d60274d176b395256b03695da9aac32dc4d0bae0188868a6",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 105,
		digest: "dba7c296a968849ea9aaa466df88b195d3ed6e2c495ce80e41b5fe802fd58041",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 105,
		digest: "f1ca47bd42965beaec4d63130365e6708dec392ec249266b4f6c4bef269a6e91",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 105,
		digest: "ba6796b09b68665624ba0575245fe3c70604c85a2b4eee6d205be2aedc61e7f2",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 105,
		digest: "12b463152926143ead4dcf538c49120de4cd4264abde8161e6392de0b9963b2a",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 105,
		digest: "7e264f266b7a467d2671e9f1b1c36fa558e94a5828fd56ee4bf7e1c9dee3cf2d",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 1,
		digest: "0f6174725116768110bbeff0dc794b02e2b8d0eb108905494dd77a79f483bef1",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 1,
		digest: "942ff6522376fcc4dc784337201083d6d74c57e476edad2b3f1f23f657d31f7f",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 1,
		digest: "cf7a1412cb625d38c3ca4ab9f2f3fbaf6d1ef56db8f37a4c16c2731aec72a1ef",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 1,
		digest: "d838cc1452e6d1c05c85948f7b04e512abd2f7942a3261a9f8d5404b7619a029",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 1,
		digest: "f599915851cbd6ac5f634d80b672db16636d0db89760ac92adb66472ac4b3f9c",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 1,
		digest: "e2b0970d96e645169fcbe492c0b5cb62309683d3f602b06dd748971df0ad0c4a",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 106,
		digest: "f32af41bc621841f5afe86ceedb540e972e438a0e27e46a53565cd5eca042ea9",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 106,
		digest: "419b8eb1db954609ef0b9726b45d33a0d80bbb96a410956b685021921ae25d7c",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 106,
		digest: "589227a3b708b092c135ed0769f668e7a0e2d3657343f892df633a0df09e3cf9",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 106,
		digest: "73057a68833d79a3ed7a9ab81014b5d7e0999d67cda6001fc169ea6ca032ac7e",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 106,
		digest: "f6107e66e97422e73f7d0e708604ce2d743ad8d3c0f9828bc1fb4a920984e9f1",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 106,
		digest: "31a25035721a4780e33a64f2baaa8ee9dd824797cef16261a9d1544db8e951c7",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 106,
		digest: "a465503bbadb055c565430ba765bde3314cfa36d3ca8bc50276c14b491170f1b",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 106,
		digest: "a71fc8c2ecdeb5b70f7dba9d336d061288ba8c7a70d7e29533fbaa2aa53df67e",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 106,
		digest: "ebebf64cc4e45f4a28be268d0b679c6077acc700bd74691f54b655a0efe520f6",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 1000,
		digest: "0562f912cb78e8446f7142aba8e8c3b92f726b35168083c3bd601c5253e61f3f",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 1000,
		digest: "090864debdc95481079d2ca5ac189c73e49b12040016517d7b81368194131b6f",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 1000,
		digest: "3ff1b64e4fbaefa384d17950a5e6cc0be7ad9eaa198c552f946956b52384b72c",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 1000,
		digest: "7909799fb49f756bb95dd18157ac1559b16aab89a7ac88ef32b392450db6e47c",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 1000,
		digest: "6b079679f42295bbc2d5d35618c7d0dc772414eb7207f712301922faf2a139d6",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 1000,
		digest: "f35f4c77ce3b0e00a232a1f775bbdf36a192f7e5bb52c0193eaef125c3a79f62",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 1000,
		digest: "14edf58d953ad51e64b500cd58776ccbfa614d58b408ce5c62aa1413f39064e1",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 1000,
		digest: "57bc43764eb9fa615f69f25e9d3e66f288f923a99849532c0a9be521c3411e21",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 1000,
		digest: "c44a2b05c52a679b154133924183b4aa0a4d41a80c04340be7e8019a3c928ef5",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 7,
		digest: "20d72062669f7514bbbb7c42adba79c0ccd2c2a9287952d82758e45ab170fc6b",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 7,
		digest: "1836732536196882f6c26e6915a3a8b147eb08cd37db65e4f6910aa4104c865e",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 7,
		digest: "b9360788fddc3b17340b62c6b069224f13b3fda1aecf5a0d4c8d470853f552a5",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 7,
		digest: "a4ba348f0a103aa4ab67501ce880bbbedf5968286e0c2cc8587215d3f6788566",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 7,
		digest: "98f47a194349709e42f0ac6b64d26c171c0147d4674cdbf54c82ae32161952b2",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 7,
		digest: "c0a56ea3dca22e9b0e5662843ecf3fd85c22865e035dd2db2b8fdbd5728f75a9",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 107,
		digest: "25c840752de07afd6794986d3b25e35ce31b53879afc45136b4b3a5863798c34",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 107,
		digest: "50aeac435caa4990b1f94f812359106f55f3f2363527fcc550429c6322c2dc83",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 107,
		digest: "b285ce90dcc3f1034d7a5d326c9cfb3b085430fcf41619e12e468ade1af628c0",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 107,
		digest: "3945ea8b50c85770e540cdf183cb8693784faaafe20d89dd75a276c3a848486d",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 107,
		digest: "2f49baa8164f5216322cd54ab133ee89d339c1718c9e6402071bbe184eded194",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 107,
		digest: "070b9d7d7fa1ed7f482175b0d28182a3a5a6a6b8de1697a0ba009b6148e53da5",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 107,
		digest: "2a664145dec15d056820faa62716e96c36ce856d867b7660ca225e84e386e90b",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 107,
		digest: "f23e856505b9b22c648dc95d72a0dbdf053e56420d15a7a323865e40df372e2d",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 107,
		digest: "ca13831fe643c5319528e0edccb07c577fb1bddb48a93fc7760a9907bd44eb63",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 8,
		digest: "939ba48f1c797d036d6c108a2a19ff5665fbf8a54bf76958d68eb515755bdaac",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 8,
		digest: "547c05b634fee1815dc245a2c02b039f17c864b3e97c0930c630fc0baf715976",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 8,
		digest: "431e67d1c6f8519bdc9f60b1632e1d29b69ab1532900550bea0131b88548f7aa",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 8,
		digest: "96041e3a314dd80a23015132d59f3e44967f267350863c997fce6219e215d2f4",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 8,
		digest: "26d56dfddfdf8d0e9ac5d414856e903fe0d8fd8a8fd5225842e25d69a027957a",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 8,
		digest: "22c779b97e3aceb5f3d3f8ad8d2900748ca763a9481ed7f58e12c0019889c0fd",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 108,
		digest: "3e7f3ae8b404dda5058cf1910685ea5c585f881b66d797ebaf5650fda78bc423",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 108,
		digest: "46d8300839c6570c83f462b42e72d4772e82d00d43d96947f3eb37ef35f3cf03",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 108,
		digest: "56705f1378fdab1dfea9844f17724c227b4b57341963048a5528ea358deee0b5",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 108,
		digest: "191a4cfc830397fdc29e7d2ec9e67bb2a51d1cf17c141859bd1fae1cbf374662",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 108,
		digest: "3a58c7e04e9c0d4fd0aa93cbc9af1a4e6052aaecbb613a7b284014298b5234ca",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 108,
		digest: "1ca32a6318a08d9cbdf0fb6f1dbe7986c2de57163dec107bdf4f138be39108e7",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 108,
		digest: "64eb0ae765ff99067393672637614b78e7e4cbf30f6fb0079525689962aadc81",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 108,
		digest: "463253d6c8e25aa8e7b1c0bbc87aeeb3c1a1fc4b779381f08eeae2dc43939e6c",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 108,
		digest: "d099bf25c89ae34e1ddf510bee70e4f9e6a031237808536e696191c4d8f84f50",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 9,
		digest: "0625ea088b9b45f5830db120835c5f79199d6335a231be0fce79cc8e59b6eec5",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 9,
		digest: "74baf0b3d7d29288d1978d7c8e3fe7ff05d475ac7d01bc0898f345f2b1560d5e",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 9,
		digest: "4d4ec4af957e89048cda5ec370591daf33d661e142bce5ed4ddc44f00835938f",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 9,
		digest: "bc510e24937d1d8fba1b69a42d1c44e1cbb792c160d43e7334c09d0e7652659e",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 9,
		digest: "e7ba3ea59ed74690e9da3b666260a4a7bce10a74c6d5111074b97c4b3b4be739",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 9,
		digest: "042dfa5bfcb766fdc9c13539bc58fed74b24a1121a36e5a14e7081a4594db2e0",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 109,
		digest: "440e92a2d45ff95f77341676706dec926272b3da42f1cd511029a692c6b6ee35",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 109,
		digest: "e68c4d22353fda0740e267795d558ea8ed007dd862d8ade7ff28dec095dda0ba",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 109,
		digest: "2971b9febeb3fea13a8699abf82c7182bb011de5480603dbe1ba95ccc59b6cef",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 109,
		digest: "b5eb9d84a529d832a812a187eed57727b0f11fbdf47e5cd392cbb746ec0a6dcd",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 109,
		digest: "8524ae9ecbb11409925064d8410ebd34b7d66acaa68c2ed285126e20077b19ca",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 109,
		digest: "8c69ebed3f0eb0c4e1bd81344235ad425fc5bcf58d91f9fda68233d7bf6f685e",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 109,
		digest: "d85ebed874ddcc956190016adc37ee676f54151b30e11a8d0d4f6185ecaebd3f",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 109,
		digest: "5b79df5e9eb37186d2431ceec6b5e8c342197706e8ee38a07e5235415f7d0e40",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 109,
		digest: "1e760f3d14e77aa91dd3cd99c970241fc8b19c19088d709faa163243f1b0c1b9",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 10,
		digest: "10ed94b66d29bb7ddeb2d1f7ba9bd30fb0f82f217d98d4e950ae6ceadb7d3daf",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 10,
		digest: "3f510ee2b118b24a9797dc72a7477d8b8ae2aa0917b325c019d2f95f08e1eb37",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 10,
		digest: "35c6f5bc1bba9d16ade786e1fc88b5a858ca6d56467bc8af89a4e425519f686a",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 10,
		digest: "4a91459197fa4d712ea71ed0cd90fa6c370492766530b44b8f32b7421f4f0059",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 10,
		digest: "b330d4d65efea1d6348becd1d3796f022b666f807fa426177cc8fd2ab1f4d684",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 10,
		digest: "cd2e37ad3e1c54f3ea6c6e0360d0c47094703653e7b1649b170495cfba9f0f41",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 110,
		digest: "529e3de1cec8cff96e89c0debf49333d272846be2796121061019bddec2cf0a3",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 110,
		digest: "aed1f33c3443cd15713cbb287f251648b9fc5545e12075b4a4c44265eb011e98",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 110,
		digest: "3d43065d054b6a7f1affe5a8596e60667405196a3b07c4f87860788ad09c25cc",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 110,
		digest: "197087690cc5c2c50f61c6d2361af5c659ecdb177fd45ca2932e6c24a2dc85b7",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 110,
		digest: "040eae927157cd2e17c381f396022269c10f2a285717a8afac8dd4fe242c2c80",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 110,
		digest: "a4ca156133bbb93e2d2ed7e98e2fc71718b0d80c9f9b9e0feb792c113cd3352e",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 110,
		digest: "212b46f0d927c584862ad48e1203cebe778f7d70fe580b12cdc029e23e0cc227",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 110,
		digest: "e7e784ef11ee8f720c18fa2e18f414b967dbc48bf5960dcbb1907e70c457e0de",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 110,
		digest: "0a9f6a8963411a21f11ee865a481b1811e29fcda11a955fbe440101d9dbdd68a",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 11,
		digest: "6bd452a228782432d2727023ede6e5435df8f82c91767df02b7ed40e0b059ec2",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 11,
		digest: "e58736492affc2a32c33b2d1205ba2c8906d1915af859562ec3e0807aa053abb",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 11,
		digest: "ca1c12325640bb95c7134d5dde71cc06d7e243cbd7abfdfbe7d510d506d8b043",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 11,
		digest: "ff5c3010891f75300cd049b3ab6d5ce0f3cd86076dcb4f8214d912ca00c503bd",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 11,
		digest: "1e55d199d024e3a8d3aecdaeec5a1e1eab2ba7902321833f3cafec3a3eefd975",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 11,
		digest: "6ed330c1b40511165ad327c6309fffb11665b2e9b1bad0a3212ee4408a854db9",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 111,
		digest: "4df819dac89f0531b8153cd2ea910dea5be1e139ae1f1352e63fc8e6927b8a43",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 111,
		digest: "90a752c3b19cf505f28c198751a254a4e9f27a61b66cf0a9892702971e3a312b",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 111,
		digest: "ea5b0de7172010dff49f32eba482ba06615b726c7e5a03c28f1378cd497d88aa",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 111,
		digest: "43898c37cfade9afe3769ee93b46e1e7f30cf95d7f7767063e64112b678bd11b",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 111,
		digest: "c482c187ebb8261b5cfef644750227f90723ee3d8425639ee573ed625e96a760",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 111,
		digest: "d924c6686154c4aa110c49b8cdc64986491cd8d9ffecc169130ef73eca387f20",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 111,
		digest: "e15c122e6d170b14ad4a7216cfcd32d7784cc84176f1eeb55e835ed4c6662516",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 111,
		digest: "9b7851fd01dc3cb0510aedaabfc299a4f98e292d7f757b02168c558f863b51b6",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 111,
		digest: "90528b9d8e674647dcacae3ba510f2a51623942e3049edcae1746036bbd2636f",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 12,
		digest: "c27a28298de8b8a21076833840cb38190a66825cae23f16960fb4c6b7a4f6903",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 12,
		digest: "919bffc6e62db3d78720de23989de3fbf8e580434ca302bde34f00d08751d20c",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 12,
		digest: "676c1dd058569d44503e345722646383d7cc1abb7bae486e06c958a54f5eb543",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 12,
		digest: "d6b31f4819fb7e7a4e17e8ccb23fbb005562a4e2672884f3c81f57d319101010",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 12,
		digest: "d600c6ce362afe096865566fb4bacf075c35ee5fbf04dee10a2cbb0ae51c937d",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 12,
		digest: "255822a38293dae38fc1b2952142444b21f0c25e7a08b11b46ef0d55892e471a",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 112,
		digest: "14d874d03b14c2417917f840bbde994ab57b3857ceea80748c8ced3c4f911ca3",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 112,
		digest: "6766049c1765af702d07d720455e1082c8cfa778ac59bff7a454e2fbeeb690fc",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 112,
		digest: "af17f594104189b1c0d4f65fa37378a19860f7e8c0ecd5aecfd843a3766194b3",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 112,
		digest: "fdf397e2b9fd1b8d660d211e9334865701f29a8aeb46645aaf7d80dfedd24db9",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 112,
		digest: "ab75be44a810f7eacd443cd259482021f8d00e1e1bbb060c99550571648a9737",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 112,
		digest: "188ed1ea2c8324e067d4b9c17b92844134a4fcfe9c02f6ba4ed3252e4eccbfb1",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 112,
		digest: "a15c88e553af5061783863c354b8f0fbcab9a27ec18073a548e726b9fee4fec4",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 112,
		digest: "ee7352688977bf5bf0e8b58acc897a819382506ff1fb3ef1cb687a8a98162b0a",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 112,
		digest: "73fdbf3b73ebb10788f202396344a2cfcef404a3005db501c57061ab36a2f911",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 13,
		digest: "763873fae9cd82afacff54b2bd6c76137d6779fafc153e2d899b92629922c819",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 13,
		digest: "638b058c1364315aefe2d253dc15ad665f0906c4e205478f8f55c57556a0e82b",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 13,
		digest: "b2a997d0d28e662daf4908fa8c815df892df6f6e6c85e9ca045f5ae6174af637",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 13,
		digest: "811fa0a34682adc78583ab02c2d663ba8b71be4cae0b66ebe7b48969e62832f0",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 13,
		digest: "2b23a128eb05e096d5944ff97263174b18a588d50481ae27c3e3d71a84e3539c",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 13,
		digest: "bf3af401a21e59c22db3dd4f0351b99322a499969012a526fdfd603c4d84fbe4",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 113,
		digest: "2e9b400db43a14415efc4a9852d592f30dfbcbcab20a3056f89b2f572faec5b7",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 113,
		digest: "7fe09c8e5d5d9464a05f3bba17f364dbe5824dccd1d358decc2311424038b95d",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 113,
		digest: "a4eb400a05675e478e74a5c2a2261c391305f7b38c3a1aa29cb00c2efd94f82a",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 113,
		digest: "ea22cf4559c6076a08d04e08285f2d0e327ec74d0c94c9ee3074e4adf7c94137",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 113,
		digest: "977e7ddfd8587a7d26148a62e514a6612c3db265da863cc06cdd4c6e4d0cf93e",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 113,
		digest: "e9c27d38ed34a5612aea9ea1e76e1df2a4926df172a6a5ffb4c0bb963bb7efe4",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 113,
		digest: "f3c103174a221ac7d381435f4abf941bd374784c848c97a456b5e35d97632760",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 113,
		digest: "884d61b5abcbc7595d48d4a791de2f3317ad698cb6368a484442308e76e991d8",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 113,
		digest: "2c44290ccd34c13689cc9657fee2ae34342e4980b589ec149081a4038439963f",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 14,
		digest: "7e3309fc0c17bdd95b711770069c7f0d09756d2b0fcb2622b8c437798d752d39",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 14,
		digest: "fc2124bbebf58fea728d382a4ca063077b1601080c8ef2500e3bd94c7a88ba72",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 14,
		digest: "4588f7fa4aefd18959661ac16c4d92c18db870a321dc2fe7a9572bedfbf6ef64",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 14,
		digest: "cafebfadda8b73329dadcd2edb4c135e1369c3ef4c0a63f3df5bff3def075302",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 14,
		digest: "7a28d4e6b40191a19349a063f6c63e0dd8d7da99efe82e3e84ce39b8844e2b80",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 14,
		digest: "e7eba38032a28845bf9577ac19fc5e3d08d13490a0391199787172a852c5cda4",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 114,
		digest: "edc4b9a58e2997b38dfb893d23415c6cc9e31d41797239c6af3bc73afa0a860b",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 114,
		digest: "d087d99fcc35ce268f5747c1271dc0436e279c1406c03ea7de07c06a84c52d43",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 114,
		digest: "5de3f0563be2a83fb7b2f23ea343430d15a43382a04c88ba9bdaa10ab66c3903",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 114,
		digest: "520d803a6f11aa436fdacf466c7bffbcd0b599303f54c291d135d4e588bdcd22",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 114,
		digest: "94492f66ae3a045d504f9cf49c6b285a4c31582bbdf366a998e663537e9aa314",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 114,
		digest: "29a709c2e65f7c82a2f88c78a479299f19dff61a51cd100da22c6253b8f163a6",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 114,
		digest: "7d60e96b8e7679e35cca947ce533509f0336f5e127e2396f7babccff911f48a5",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 114,
		digest: "aac589bdd030af004ac770d7e7427cf5a7325094326878a928775fba9220f177",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 114,
		digest: "b4c75379862402b69839845ef99eea9c5f9fb746657c4ca8fb21659be114b1b9",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 15,
		digest: "93731e302018c5c042f0a47bd23dedad56e652b715a2d055180b62d1ef8a7948",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 15,
		digest: "b58e222b85b75ae60f5682f1cbece378bc4439cadb3a6bfa8373069075709662",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 15,
		digest: "c48b58ad76bcabbf8139c28185f9348b8193e06e000ebd0036cba490933d8532",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 15,
		digest: "ff8582dff8ab2cb2931425978099c0f2b7820e6c7cc103d7158a652a676e6de5",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 15,
		digest: "0c0fa1229081f5cc541a03b49123182289c580441706e983f2b2f317dbb86664",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 15,
		digest: "682913e0d746ffc6cd2bd92b254e477646e8284971d9236da3b960e6fe3dee7f",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 115,
		digest: "752809957132fbc3aacb7e51294bf62ed3a9e27d909f6433f4c6700ad4d0cc21",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 115,
		digest: "656ae7d3235c445a4e350dd7d145938a535f84990aee6eb1f9ecf2f97a05cbc1",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 115,
		digest: "f1d808ec249ac6469de92d7d8d1237e2680d52629765b799a0c146a7623d5a06",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 115,
		digest: "3603f17b87107824552563ab04c885e113e11a3417f1efd03c1ec5b782f5c69b",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 115,
		digest: "5cbb8da153e7a5c34019288c676c1be8e702b0005a0deaf954bf6aaf54829668",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 115,
		digest: "c83d4b495044a7fd587913d0492c2468701fffa4a3f9dc4ad419e90ba466ecc1",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 115,
		digest: "c578c7bc80c4ba4c7afa073f2a293136c6e0da9734fda1dd3b0f12e14ed8b96b",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 115,
		digest: "81ea1b21b8a996cc0b5c7a7054347c02ba651bf8384ec83e0e21732ac34964dc",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 115,
		digest: "61a0493967150f416b4d51f3f68cd062030e0d23f923b53a93647900f95b3344",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 16,
		digest: "c942f94a8f839ec3faaeb3bc3b2aca08d4c8504db242a13236677b2760e0a33c",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 16,
		digest: "325c7dabc40c869caa291d6d1bd31e8205b4dc682e5867cb0cd618e9f948b575",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 16,
		digest: "9ae9107eabdc666d6fe719f7915e0ca4e34b031f4bb2e99c37db47c13240ab78",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 16,
		digest: "7b596e7179d1b53edc1be2125794a0ea6bb4dd978da3cc8adc538dfec0e3c25c",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 16,
		digest: "6f9b3a7c1490f70fd86bb4063d06462a4db64740aa2a370ade8c3f040bb19091",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 16,
		digest: "c8ec3dd55c6c4c19a61036546303c4906d668e36b026b932579012e39f829c33",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 116,
		digest: "d33bfe147272a5abacc1c8d93853adbb48f60ab6125994625cf643aa963cf3ec",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 116,
		digest: "decc838a2efe8c131eda8969729b1118413c4e0bc0be4fbc2567a16d81fbb162",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 116,
		digest: "bc5fc14fa81cb4e2a7f0fdd5e3a80498a8ed163bec076fc6bc5abda8038229aa",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 116,
		digest: "b0761ed9b0962801b242ea2d3d6ce1d4af403d67cebfd3758f6147898162486a",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 116,
		digest: "de78a47feb38334e739451c3cda6d0ae1fb53c69fd949778e3d5c42c2e3cdae3",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 116,
		digest: "f963ced3877a89c97baecb31a80463d1e96935695283b13f7eabcfc3cc8ed362",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 116,
		digest: "f00e73e94c55dc60b7e606bd3eb54973560d52640e785540610b47ebc97a9de2",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 116,
		digest: "f5d2cc8818cfd88b537dd84ea0bcc4ae5501ccf38f245a706f42bf87666349d3",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 116,
		digest: "e0413da074bc32e3eae95f5c62476a9d5325563ed2aed115730bfcdddef53a88",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 17,
		digest: "db101a4d588cd10731abfc912e2e583b1f138f9a5fb358e7f1972986c053f8c3",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 17,
		digest: "e4193fc1afb2e862f352d0cf98132e83f1c8317218a6667ad1b6121469ba92b2",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 17,
		digest: "91cac05918b29f9b02cca7e7862f1ad0fc2b5d11b1c27084366255c6f35294c2",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 17,
		digest: "d6efdac97e0879c656348ed51840f7ecc585ae12456afcfb2e9cf1647558436e",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 17,
		digest: "4afdbb642e3c1127451491bd8c9b07f5c2f07a8edbac1faf9c5231c0335a1eb9",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 17,
		digest: "4f273b0c9c4866782f46d0009facee6fa31a5f44cd7b72aa728bb5d25c810358",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 117,
		digest: "26976d44f56b31d49b945ea53a63937f3302e17fecbc929edded755430d63067",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 117,
		digest: "7fe0e47576ebf3a426f1c1a9eb729bd019daaf986c819ff933423c0101b36cc5",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 117,
		digest: "a0cb1c91ca1b3e4d39320800c797bd02767bfc995ee08377f80fa2f8c6212cf1",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 117,
		digest: "06de689e4afc09bd95513885848ae6b120359e14d4348aa5bf12ed7c3ca07b8c",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 117,
		digest: "12ae308cc0afd7c1f10689590966350f5c232ac2b6a82570da892e973dcc86d5",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 117,
		digest: "94b63e0a3e782638496df6111c4d0432388931a3c1da94ef7cabbdd4e553f565",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 117,
		digest: "165c9d738d3f38f683a66d97356fbfb5be4b7992a66942c04d91a05822695907",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 117,
		digest: "f0087af6b9fadb7c3fff5c7e663d225b5b3550f75b24b8cdd8fb9bd4e9a3bab0",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 117,
		digest: "24964915ebb561a9b820fbb1151b16d4397aefd316d01f1ae928ffa76b4ec86b",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 18,
		digest: "a06f15e8acb31e7d692e514067ff2c5e4606c520a071930cbf34f16290a63d59",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 18,
		digest: "3f4528db6fa9b1b9556a45f062dc45bd7a48b6515d5a2b4c6b8a0f4d8ed68372",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 18,
		digest: "d4fffa34e44d722d77bb9868bf87c6c17075296dbecec7de1a1dfe4ba1506b44",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 18,
		digest: "17169663c68e9739731656ac40fb4d0ce5f5b5de53fac714681560fce059d986",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 18,
		digest: "ede66fc9bfa39c4c6bab219017b27c286e8ac6f8a2ea784eeb53c93569d5ce35",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 18,
		digest: "fd74a5fe3546f3d80151124174da0e9f2b4d82a33d738fc833bfd47ce4d0d61a",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 118,
		digest: "f3a72d3d1e987885533728d457d645c49a7ebb170786cdd368e031677c24ed34",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 118,
		digest: "ea9d74b5248f49a24343ce10bbe6f35f4fd7dbc0bec3c507645658384c125442",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 118,
		digest: "b72f4331392909a4aa5b9f53d7f8e27c690662f840151b9f01bad4ffc17854b3",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 118,
		digest: "dc561f4a2813647b4efc70dd8b96949f5250a8d9ed191e2af12fbd98e759d4d9",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 118,
		digest: "4c1b40857c0ab9e7866f41a4a45ec5cfd50aaf1015253b1061eaa21e0ab915b8",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 118,
		digest: "8a2c59cc39c854f8beb8973bf6a5b19baa137dea51155947538e49ca2603c1d5",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 118,
		digest: "935d8c9af1613f5731669366da90df227253b0af607be1a9c2cf455a7b9d090f",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 118,
		digest: "50d3bf1d6b3a3f7192c35b8f796490c7eb644239bf83a6415b5901bdd103e35d",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 118,
		digest: "1feb191395c62114d2b67ea265843c9fbf223e8aa0669136ddef8b0fef9dc75d",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 19,
		digest: "10a13bf0ce52c81a2023607951a776a83a1cf5ac55c89560966f96946e905db1",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 19,
		digest: "420fe514c539be0bf5990398ed888312d78457466fdbe119aa756b01ac5eed8d",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 19,
		digest: "f3d6b0b446fca6adc88982bc8f1e3347c71a79cd3d7947fdc968a5ce3189a843",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 19,
		digest: "af95c0c2f46073111dc86568718871de828425cd90304ef8f465369eb6387fcf",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 19,
		digest: "65a3d5605235cd69df1b5b6ef7973e9cc5b82655c9da638844e19662d7960ef3",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 19,
		digest: "3c6d30c8a4678cd6e2d4544fd2c3000630ec0f24e18e83a512c4bdb2008c46db",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 119,
		digest: "62495f850939982ed0642b7ece730f7e542f284be381a26244e49629704594a1",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 119,
		digest: "5e3b2a1a95fd318e8a0b0a0edeeeafaf01dced30336647b6cd5e4f54e4b19460",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 119,
		digest: "6dc249c31019a94f315a29182b7b4be15e9caee312c0147629b6ee1cca0ad143",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 119,
		digest: "6a0946868ff73d93f9569f54c2f15d5dea40e364bbc9638ca5a5f8f7fae32dc4",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 119,
		digest: "b3651b0c46c8d9ecec2fe03f11dc77425cbb6839cf29d97f36d392f212d913f5",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 119,
		digest: "e3871ccacc2db4ffde8c140e6101b57f4ce25c08e8eaee1ce8e7a4df771275de",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 119,
		digest: "4eb8f4e648784ea915d8bd2acfab5246f8a658f2580d47ba517748603976ebe2",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 119,
		digest: "444ab2444d1d32182805c07e2c505567a71bc8d7c070fc8a20940ca150d4d786",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 119,
		digest: "10d06639b1f7039d4db2c33ec852d5cb03ad7d249ee2d0404add96c73e8c6d44",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 20,
		digest: "6e3b0139d5c58d93b0d4840f963d85bd565daae229f543e231456d5dc5c2c3d7",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 20,
		digest: "355a12df6337493cb6a1ab52a9e13e4296eb80d509b0b638bab5338924001fb8",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 20,
		digest: "2b52c532b59938f4076f4d478209fc9db4bb3d85a7a16461d047fd6e024d0753",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 20,
		digest: "6cffa8a4fa9cbf0790b1405d093e2bb7afd3e021886b7566cb4b61ae09773249",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 20,
		digest: "b20207f8c1bcefe2b4bc9dc0c9d603cd78eb9084d897e5284951b9c419f8ec68",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 20,
		digest: "39fd4b95235350c92142f1e0db86fefc6b3897c9864e8277223820b6d0a248c5",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 120,
		digest: "7c552ad1824005d92980137a72a92a5cea3db7c650fba37edbde22fd7aebaa2c",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 120,
		digest: "182d4440dcc5cbc206444f7c4e9d0e8209311d20832f7f0516225fe71ccceb70",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 120,
		digest: "3997b8a442e83a6ea583d08d46b7dc66d0a3513c9e5a336a51054fa99b453b6d",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 120,
		digest: "9e0b792e49c9ba1888434d9e150077dc0f0d3896356c6759f1e1971ef866d8f7",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 120,
		digest: "2dcbf3bc01c1d6aa3de6f16f6e79796052653d25c3055ecbd805d6615c0b2c50",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 120,
		digest: "37ccbbf3e55658b0e997b74ba7e9ef727e1759a135d82529e7d44078356c6293",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 120,
		digest: "4c75b3f3e3fabab00615f58e9982545fafef92434358049f4554972dfbcfde3a",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 120,
		digest: "45cba76848377268df98669390315473f858bf10c6d7555fae6ba5c17c03ebd1",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 120,
		digest: "c48320b85addc5bddebc15cc8ec9278885caeb22fb42617bf3b13b043bd44c14",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 201,
		digest: "8130f76c2814ddc5ca59f090e957996889d0638b6048321eb222d42d1ac53d0f",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 201,
		digest: "3553dfa3f411a7ca1e03052e61deb06f0873a1b5ec07ab0a48d68919a79715fe",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 201,
		digest: "3bdfaa662652d8140157e337123ed453549392d40b3530b8832490df70f32b11",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 201,
		digest: "c3ca1698b2c8c687ddf414b5935c23233565e664805dc6d31d4b1b3c85c8b298",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 201,
		digest: "434ba19dce77d293fa5fe8eb3ad41347bbc9b9ee3ac001ab4e4a79bb329fb489",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 201,
		digest: "de6e15d6e1ebf92f3e1312056a170fd5ca531502fd78ee042c18faa8ab54a9bf",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 201,
		digest: "d52b307bcf2d5c1e4b6531ef7ffe722fcfc4bb813022d4762b74773d6d9c31df",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 201,
		digest: "1bfa45458d42cb620496f8375e55d49236d593af0ac3032332cb353ee5f98cd9",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 201,
		digest: "2b68c8fc66cd872afa949ce31abf2ff46f5668647c8c10903eade722ef9ae57c",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 202,
		digest: "1f5875d6ef4bc7a813fc6b57cb13c9a41ca49131e0a9922e79b0dafb58cebaa4",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 202,
		digest: "f6c907ea15ff9ce926d844e2e0306dbc4e087074cf891737a8f35c43bba11a2e",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 202,
		digest: "d79c8f62b3727de766c84c86066b93dc88dff7c9b6102857c0d97d2ca4c5e023",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 202,
		digest: "56aabd3e8cd3da04a41c039ae34cd867f6b49b3edd937ac2e471b52739061d92",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 202,
		digest: "2dde3fb4c16421dcebf4d773ee603aeefed7090401b2666c74654f70e8732dda",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 202,
		digest: "9c66b67abc191df054c94aefe4a872fc752f673985a40b39de74b84b10606ec2",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 202,
		digest: "d34733913de8044a370153aed0da5f44cddad4cf7cf21bdcae6336a934ae1a6f",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 202,
		digest: "bc1abc22ff9b8708457479f35258b728c5f3692bb3ae9f5b3fae9935807f8da6",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 202,
		digest: "be120f437c21bb06410d68c9ebddb5b79529ceab9848bfe8bf4ffe902bda3cd9",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 203,
		digest: "afd6938b6e2ca433c8067d75ae9c7a6f31cd40ecdac995ed6300cbf8cfaa39ad",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 203,
		digest: "2b8da6c923ecffefc2646f9887db02a0f35ae1002e309ce29de16f22e78aa0a6",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 203,
		digest: "f26e68de0da738359e5ea4d5b144dbc3292f03e89f3ba62bcbf05334dcc30566",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 203,
		digest: "d62aa0fd369f332783d7ed7fd14c21ca6f3ddd47f54ee54d84d5cdd7f613b9c0",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 203,
		digest: "6f4a6bbbeb83d7366e7a347fecbd20291ffd50250beeb935df29eca48413f0c5",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 203,
		digest: "2f2b55ab8d82b03ef06076594ebe5c89156d019fb57e30732498ddd31d29bd88",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 203,
		digest: "e6454243c409395c85fc386e5902c1bd02a7a444f0b58b6cf26436224eb03fdf",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 203,
		digest: "f5ea2002dcbdecac9871c8b790b7f9e6004e5334ea218c02e3b7bbc17f35c055",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 203,
		digest: "cca1e5e9dcf43e3fea622cc24f5b52124b7345f6bfe63fc7d2859f713bf40faa",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 204,
		digest: "d916f2dfbd11975ba8a4245be0fd1f12c8165337a422091f44a0feed1c983d34",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 204,
		digest: "6ba23f592a892731e0782a99bda53d9b76bab8af70f74655ae425ae9af376177",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 204,
		digest: "83dcf9d9c6e8c15b7b5e03998d5e61a91e9fd163e47e232f7d8d4327ccf92d0e",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 204,
		digest: "eb8a12ef1a24cda04a9f7ced847d9f118f9fac086c088ec4a870978855992ba8",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 204,
		digest: "2afdc1104ae649e972866783ec56729be4acac698ca0fb66a6ad3f80df636d8c",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 204,
		digest: "3791a753ceab3c75b000bd1ae9fdc053cdb03d7bfdacf088705b7e212459de9f",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 204,
		digest: "26fa5a9b689b622622c1bf24bf6807f414232dcb6d71bd43bb0bbd6be3e10b80",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 204,
		digest: "7f5634a0944bf62cc7a7f4c3f08cd055cbe09008d5a2262df1bb1dadc4180c9e",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 204,
		digest: "bc394fe576e70709cfbfa6fe8b36f9a6d1a8ddaa9e5086a7d126733902db998d",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 205,
		digest: "344973d1183a695988686586a004985b556dc76b5a58517b6eb1391524ed216c",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 205,
		digest: "ffa9ea82264ea80c7f39cb8c090194d859740b05a120d2116415928426bc2622",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 205,
		digest: "e6c7cfba66ed9e1f781f8cf96489feedb0718834f7fde6d0925846e1eb856eb5",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 205,
		digest: "63330a92c7ad8cfadb07618a22b9a7ec0c36c71fc85b0fcc3a027a87a8f5ebd7",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 205,
		digest: "7e36dc38f9c585cf20e46d03049ff45e0524c5a1b6e52ee6ab81f475b2f96e68",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 205,
		digest: "672814e7b937bc2c70aac90574f7a97b58af5efe7b8ca0678d1009bb73a80f43",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 205,
		digest: "4a0ef9deadb4774ba377009f6310a1db24703e7a77c6cb2d7892449a7f4824aa",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 205,
		digest: "407707aab96fb05cd7d86c199285f0f3819588aca20b8e929162f795c11291b8",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 205,
		digest: "723891f2ae30c63523d305084180294060814470f6bf6576a496bf3efd5fe3ac",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 206,
		digest: "d7ed8f5328c0eb178897b8ec845287eb322ff808a306aece837e4c174062708a",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 206,
		digest: "58da668c697b1c5853fd0012c71bd9dd841a7520554f58a064722fbe6b3ebe1e",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 206,
		digest: "2c5799c432c5488cf2f3e5124ed26b1c04d1ab1eedd8753a694f503bab161e00",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 206,
		digest: "0fb88df59b4d64b0694c5abb34cb383147035d5c6517663b3e8866e2b41fe887",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 206,
		digest: "f8605c30564eeedfba75ef95f2c91f19be55d1206b394f66fe5fd736a75cdcc3",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 206,
		digest: "b8808a710bbc0de81d72fccb5b8e4b781675b0e6a9257893c188a66fa4e76624",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 206,
		digest: "b1266e74ddbfa471c5ab4a00368e1200db8ce0bfdf004eee7fcf5698dc364e68",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 206,
		digest: "ff17dfd5553efc62b8aad33db92ca9135c35d37c1ead31f7530056c190e92142",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 206,
		digest: "a6609a02bc9f3c4ca5433b2989e85c41bb3497dfd5776b7a3df214b5632d4f67",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 207,
		digest: "7275169186db57e4230294d1dfd1b1d9f1801c8243ff41b7ca7517758428dee7",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 207,
		digest: "c286befe3d786714d67ebd6c8bc58c533c42385254e3003800a9c161d00ed3e9",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 207,
		digest: "01558832b03ffc3749a5856ad5ae0434f01b30bb8c243f9f56ca3aebacdefcf0",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 207,
		digest: "4fe2241b13e42fa769e32a15be7f2c8be21b8074c1c61aae465369c67a11f2e7",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 207,
		digest: "f55bbbef7f291fc219e07d51f314bce2f58cf9b3a676df167d86e22c96ed506e",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 207,
		digest: "d3f66311840dc9226bf3b96ed1f1b616cc33b6dcc3d390fa91b5b5578864ce50",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 207,
		digest: "79bda5c1f40195ddda02c668424ae646530d89cbe1ea8bedcdf0e61c53dce9fa",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 207,
		digest: "fa86545ce57ff4e385a74ba28cce63a805eec030c938d857ac50a5a58fc2de40",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 207,
		digest: "e68ffa85c4d4f3bfc402bc3c8bd9e3948a64d9930e1be41e2eec8011696177ca",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 208,
		digest: "e9c1d5629137cbe124e2f57e27b6eb744b73339c3ef5d94c8acbc21ac9796df9",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 208,
		digest: "84168dec8550d5f7e27a217b9ab9569323129d5d057d77a4fdbc87c18660fd68",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 208,
		digest: "a62adcc83f542aa37a88299f5b17834c5ea0df0392341d16e5bcd9ebb1bd31e7",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 208,
		digest: "111bddc3a7b4f6b5955ffaf67056fbe2150d7a09ff77a73a88b3c25f076b777a",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 208,
		digest: "b54ad1c7c8800a8dd11d479e4bae908da2448e518cd530e6459284c36b36f576",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 208,
		digest: "31061554b5865b11760be11666021bcf8e913bc46300444481491a8fe63cee2d",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 208,
		digest: "f3ab562ffac17e530fd624c217eb3c2e6d9a05a36792a39f509bb688e1a23da1",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 208,
		digest: "327c661bd83d30d1e86402f11d0c6bfc86203b489c1b718d7693080fdad71506",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 208,
		digest: "2526aa563b3777ff6f2390b2fc560caf4ceedde8a23590e2447946f2dd2acca5",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 209,
		digest: "9516119369b3adb9eb4a7ba25206862a7abfec652127a62d67c9169101c38f58",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 209,
		digest: "fc3ddd8a98a19d6ecd2fa2468790872e7c96cfbab133e2a8b31e25b67f5bf1d7",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 209,
		digest: "a0ac4b009a1589f740220217ccd0d67e98b147d2826f2f6d49463f0a35866626",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 209,
		digest: "3ff9c9ddec8d07378e4d7176190c3807cef387b28e77edaf821ea1cc2bc2181e",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 209,
		digest: "7e0bbd057cc8abd31e68538a3b1328610c745d5aa6d6a637a2cbfc3da8b313b3",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 209,
		digest: "ab29347dc18864c6b4c4715d72140d5e8c0e99ba24b438eea324c92a2700042d",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 209,
		digest: "a3871cdaeb479b3dca708f69c9f1519b717d77568317563edd949d46c12fef3d",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 209,
		digest: "8bb986a1518e7781f771bdd91b44a30846a09a89c65cfdac56c24aabfd555ecd",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 209,
		digest: "8327ed9c9f945b4054cfd00cc9f44a204a7cf20c583477917b75d74395d55c70",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 210,
		digest: "46ce2e1e7661ed6cd17816347caa393a8537289a771b8734d0edb885481a5c62",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 210,
		digest: "631d198e901258fb41f62c38d25aa220dfdb12a857d1c15c12147594c987a940",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 210,
		digest: "03bf1f3de44fd3cc9d0f6a6333d550f4755781c63f517ccc2e276eca54a3c52d",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 210,
		digest: "26352de199a4032b226d5a4a1654dc9762820a484b4f0e5d599a3b07f9912625",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 210,
		digest: "e59b936b8ce17236f6224673b99e6d8b9ee8a6e5f42683e1714f1709e0c71c03",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 210,
		digest: "d0b7b261c88c9fe7f8bdeeb78c2c24deb1d86ed577934ebde300d21805c0a2e7",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 210,
		digest: "bc84b887535aa02e3c2dfe536e4093ee6eca624b36729bae344c7e96fa5249af",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 210,
		digest: "583d5ff7b9378403ed88f80edbf878e454281b513a6a310d4d3b765f5e5b2573",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 210,
		digest: "d1227dd56bc457e1229f2e4c341977f39e3ceea262f7ab0c661967ef12cfbbe6",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 211,
		digest: "5911ff2f76dd5c18b83132b0ab728086cce9e0558048df4a55ffeafc3c18a3bc",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 211,
		digest: "6f9e9be7f9282c2ad0f57566e96df44c1744d52684f7afd399ecb3f64433e20e",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 211,
		digest: "18e794ad4164e6600a9342965142d280b8d34e77b9b13b4cd059a09a0cb96862",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 211,
		digest: "a7e42a2017219854e5d561675b68b71ec1810aee40fe917afb187a404279ae07",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 211,
		digest: "1b54da6a541b608da3ce268519816e3c45583052c5d4d59a21b0c93a9308793f",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 211,
		digest: "c303e2bdc2554e0473a12325b2be5fa5d9867e398ac01651fc287be95627e645",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 211,
		digest: "0d5f86d4e7617589913405eea0a686916f9b1fb2432c00dfeb70b40119ea9ae7",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 211,
		digest: "359cb1894d43e6cdce31acfd2aaff2bfec397ed2363ddfcc978a5dc08a81b218",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 211,
		digest: "a1562aa801ccaab65666972217ccb06cb98f188ae050b2cfe5aa85b8a9683739",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 212,
		digest: "602608fdc3f0357e4369c8f781d93c196e8d4ad88460c7fe7dd9b00bd30764b4",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 212,
		digest: "07acf3e7d455a9598c9d2f5c5cdad48f243636ddfee9c0c2af5b29c156da1610",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 212,
		digest: "7ee505634a449b64d78779f3e7d65e2b89e889b32c7a272370d93e2c0b85677e",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 212,
		digest: "7151c262ddd3a63e5e5a5faa4f51cecb530cef06f9f4524c003fbdf4b3611853",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 212,
		digest: "5f104c580c71976204ac7a5ccd3c72952190a8c6db60306db63106bec52e5a75",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 212,
		digest: "5b6e8ba643556432412ce34dfb2e6059d4ba0fbb8c0bf30e695cd0b8d700eecf",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 212,
		digest: "f3275093fe651e6e658c8879b1a29c7d37817064f8f4323d18534380fef2fd3b",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 212,
		digest: "41b361f90eba98f361a6077332f643e5b80125c8831b7be17eee032513b9576f",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 212,
		digest: "93bd4ca3fbf65f855de919dfc79b1a55d8a8bd3e574c9165ebce8ff91a6db64c",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 213,
		digest: "e84d5980c004171f2a59f29b7c289147c3d75f68d6799edb443bccbfa3e5cff8",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 213,
		digest: "3f55677dc168db8edcbc50c6e4dd797b7db96bdb10061503adc8dc5594a6f48f",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 213,
		digest: "404fbec9712430fd0c59afe364b8e77940f1d61735d014e1da89c1e9b0e1f77b",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 213,
		digest: "2cb650eaab1b441c393cc4d06705ef2558c6cd5ee5b5fe338af41530d2606078",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 213,
		digest: "075aaa8d60a859e0bf86b7185e098b646ea48801dece4ccebbc824dbfed67f3a",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 213,
		digest: "9c9c5fd39a45560c1a7b2ae42cb6ce2b3a7cdadd6d26a56e05f0b37345a772f6",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 213,
		digest: "8d479b9e80a40c04755f971c7bbb4b454d6674ed0c4220293238e6310674d805",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 213,
		digest: "b5c33065a8ecfbfd50da8f656484893a955a649248d043078c09bce46e8aff7f",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 213,
		digest: "eb1770bdd8d27524292ef8cc4f0c334f4662d456a079d57c5bc2b00f277a266f",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 214,
		digest: "bfa2c25475d79c10afe32bbc0d0f98a92dea445d70fa763cb67ba6fa9b4b2b76",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 214,
		digest: "2e1c9fbaca2c6a0c031bd7e3fecb1fe6a71c60c1044b092321ed25de8afe6c78",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 214,
		digest: "375dec92bd4a3f3d158c7c5095fecf8940829053274020f8b4c540d0db848de2",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 214,
		digest: "4e917dac8e4a4e8f9378214e0ec61e9f6b7cf26049e14583219d42830ad09d82",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 214,
		digest: "2da524f2e2fb00fe92bc91d86e668e7d730a0ff0a78bbe52517e640cdcc3cc4a",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 214,
		digest: "309fa4d4ce22eb3acc7aa03a254d3790631860e6ed5056543d2bf2e05536cbfd",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 214,
		digest: "9b03bdeb581142700cf95f6736dc3f4e099c009924449e488d1d8c76b3d13595",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 214,
		digest: "606305afaea510f78824fd120b962f262e84299577dffadc62db943414afc953",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 214,
		digest: "8782e7a2053197084874a107e389c4f1302e41e79833a110e1d14a5643c23d21",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 215,
		digest: "c87092b6df4bc0f026f40a6bab63aac5457e890888447c6ccef250c2c095b7a7",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 215,
		digest: "a6435189dfe29dbc8002587e1d03ea85e362ab13ed075bfc29bb021a8f2d68fe",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 215,
		digest: "1b2801873ca4d06da8d362b4a201b46a88873bcfa359b4b60b93bc6e0fe7aa7b",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 215,
		digest: "5a4d5cae853e00861d17e74589aff6340685ccec8aad72bd82ff6d86205fba00",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 215,
		digest: "af2a12dc18e6d879a5301ca88d2cec7986cc95d1e9d5cb67509c77bf1b80f603",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 215,
		digest: "70a358e6be9c8234d5c6abf4f48609f665ae25e1b843328392ff6d0e8bee1be2",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 215,
		digest: "37a92d66260e87f8f88f04594605402b5b7af6bf0c8dc9effd2f24aff318ad56",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 215,
		digest: "3d64545e0c27e20324725f5e619ca369097b73d4d3fd5a5a28a3a42f825191f0",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 215,
		digest: "0c71f49ae5ab34dbecd767a341a1a551a2c4a15a15912b8703faf97593d5e4d9",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 216,
		digest: "b037abd64e67e3f04f50548b2ceeecee6a56e1815bbe772e2ea25d79e4b2ae48",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 216,
		digest: "30d5751ad0e9c637f42ce9411f8a09d858e2f3569b98e7b570e88d2dd1e6921f",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 216,
		digest: "46c4e482e0ca897f7d757858393df60dbfcdaf8c114cf7c4db19dc6b2711fa79",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 216,
		digest: "cb66d66dce7fdc09834f143ad5236461535f6b02258b180aa31593046d63294e",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 216,
		digest: "906c13e0999d009de77f29b9fc8a149ecb19f8bf50f8610d5603ab7c6588c9c2",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 216,
		digest: "31643382cc9231ce78e77f468560f264dce9ef5ede77f13ef43d0e276d353112",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 216,
		digest: "2817c21bc309581dff826f5445eaed3795d9fb0d40371fbf6e702811b280787f",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 216,
		digest: "718b9e50c9f5df8e4bdd5e936edb5c2fde717b037fc5e9a119c0b799f5b1c584",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 216,
		digest: "dcdf7b9c6b1d2646516d907a3732a687dc03d0df8ef00881451cad26c1149eba",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 217,
		digest: "30162de9731ef500b67fada695a67a193f9e6dd9e33f9a423b22456580af955c",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 217,
		digest: "51c3a02e91647ff3a46806c34879ba58f05db9d36488e7abdaa2755ab3fc93c6",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 217,
		digest: "1cf7b2ac17e5f8d7855139b231a92751873425eeee19e57052ea1cd4d88bb7f1",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 217,
		digest: "93fca7a74ef15fcdf8f645ba617721111c8fd9e0b06aa0ec4d0efa6943ed4053",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 217,
		digest: "518d9c1623e33e97e06fae34e665c50a07f649768d74e5b16eb6fda3e1cc45bc",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 217,
		digest: "2c767ad91e99e0dfefb5e446b179485dd82934d0e66904b30e779ad7756d77c6",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 217,
		digest: "7dc35ae5e1f70a62521aebd698783a4422ba534cfbae6e126d2c8a6fa4c5001d",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 217,
		digest: "42ef56033eb78e8c9bbacc7e6c765e4966ef8ca6a1b3c76b0de5b1764fa2fa69",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 217,
		digest: "89bbf9698e1baef7a4f95405cb6a2ea2a440a53fd1d441287146946b452c009f",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 218,
		digest: "dad020a2e677b3e9a32bfd2169b598041752e4c8f47b18fc1df7803060df0724",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 218,
		digest: "8f3a6d729cb71a922a1899f5cd68f9c199895160605f2b28fcb5ae86a354c4be",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 218,
		digest: "59e4104bbe8fa70fca98d4f83dea2cc3c0ca8cde3dbd49a6560aa288fe3cde27",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 218,
		digest: "6dc1e92b79d2147e1150310060be391160cc70394a4625d8787e36065b1d3455",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 218,
		digest: "2ed0fbf83c2f1a97e301cb52371c5d386b20a6b2cac119778102b69ca2616f9a",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 218,
		digest: "18479e02052dbcdf5c54f33ed9b67a7336b3b49d1958fce0a1456b05eff251b6",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 218,
		digest: "c2df1a47d52b557a211591e5a23c9680346e157d819da84b11373b825e9383bf",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 218,
		digest: "39ac30114fcd87212efe160c9f8d3e8742f0deda5d86c8d738fdb0bc83faa49e",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 218,
		digest: "053ea75f1a69189005fe06a1496dcbe790236b07cbb8f66e14a4a251bc599332",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 219,
		digest: "1f946e647aa75bd4c7cb2f72a52543d48f68fed77c1bfa562f4450aec4546799",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 219,
		digest: "c1f715b09d208ba2e8d398a3b50ab80deb8b17e2d69b846078cac2fea546e128",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 219,
		digest: "8415eb97ca9d73c454c962171dcdcfec504106c1fe7cb91ae7714339a9e3748e",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 219,
		digest: "6dd07e84cb61a617e8a844faad646eac7c81b0d3ba1cfb0b217bae77ee55fa25",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 219,
		digest: "162c1aa724fd8363825785840af511e9d31c1745b0f04b8e79c9e5377455baaf",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 219,
		digest: "b41c1fd6ece5f94056b06af48fed0a00d3e5de45a3e9269f3fd5357d0e1b3c1d",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 219,
		digest: "b5d1a80a7fd515b6a5c485b4ee9ea3d4175cebb0af9d644d2c11751bece5aa78",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 219,
		digest: "57b516bb17514399d158be5589fda28e53203c85944c5d6fd4f3a5614988be51",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 219,
		digest: "cedee763e8d56ba47499ce70ce437a9b5ce1ed35a43f5a125c42e45aaf8e1157",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-full",
		version: 220,
		digest: "906ff64494f1091133b7cd9b9b2902d6da210b344c629ad0b88a74e1d8972e8e",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-propose",
		version: 220,
		digest: "eedeafc826d24655de29b95e663b1eb6abdc8747846fbd9b08f2401dace86b72",
		stepDigests: {
			"core.plan":
				"580f709daabc429c0242a9c42cfafd5e877662f422c9995ab5e4528df1a098fd",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-apply",
		version: 220,
		digest: "ea1d506430cdf6f6556c0ad949c10b242182dd705001caf75e5bc0cf4afd6f98",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "no-openspec",
		version: 220,
		digest: "498f9ed31c7062db90da66440b90111a53d703bf1aab0176ad840c0336f7fdd6",
		stepDigests: {
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-full",
		version: 220,
		digest: "e14ece93f95fe44eb83b0daa70e6ab51fb14cf6e0ad489924dca36d049ae90cc",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.implementation":
				"c6a0a68dae6d07c1df1275c40b19e0b9033bc545d82394813933cbc3607f1f56",
			"core.triage":
				"d9b73865e7d0f5dbae92c27cf02ee10292ae8f561fe73d2f66732a117c739cbb",
			"core.verification":
				"6cfff3c14bc7ca65a7fb9812e4b2b41ac94f4aa6983b233ffc1a10133f9adfa5",
			"core.developer-review":
				"6971f0f3c96848ce355c2bd1e94a126404ddc48de78325f4e8918e046eab84eb",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.archive":
				"eb4f5fa3ac2d1198fcf3a5dbd14b05f24e949b4f7f09a00478fd127e2f48f45b",
			"core.delivery":
				"96d619f2fe16425343403de62f3b202c57522c6e59ab10dbb0b75e45ab5e8adf",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "openspec-fusion-propose",
		version: 220,
		digest: "ed6c9079917815aa8af9100c701952b2a7856b55a31c04074114608b133fb4ba",
		stepDigests: {
			"fusion.plan":
				"ea97626e45234932f100e422fffea3e30c5dc0e297d43dc9d935adf9007348aa",
			"fusion.consolidate":
				"fb20db58c5f1b9c00f38fb3dad28b3ec5561f7740ec58339b7b85439bd0914eb",
			"core.plan-approval":
				"b491090a0384e6e230fd84e02ce7fff8a0341cdffa406277a50d25a21a31eee5",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "research",
		version: 220,
		digest: "3e9b05e8e9a2e2322cd5f8dc5fb1402811c05c88f0982d89175b8e621b01987f",
		stepDigests: {
			"core.research":
				"5282cce4595026b81389183db8d4cba8c1e039b4dd17ba59c743db9012c63838",
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki",
		version: 220,
		digest: "2dc868f6e133ecb0a84a1790a9ebf9746881ad6631c72db1024469081cfd8337",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.wiki-approval":
				"c25d6c05a3ad1e68cf13f5d550fb5eb2498fdf8226048b77e7846efc74f67ed0",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
	{
		id: "wiki-comments",
		version: 220,
		digest: "fd9eac20a23ddc6051614bbf88c7cfaa5552f240837677c31029f9550b48c52c",
		stepDigests: {
			"core.wiki":
				"b969c4d7a803a03dc3f28a620c07853afa649544364ac373ef6350d407712382",
			"core.completed":
				"62adf8aa6f0d99ada0d0b45c373e4673290d8447bd81f42a973a39a3282f4164",
			"core.closed":
				"f627e259325a2f4db5b90020a04476be77510d90ac85e08401825006204a425c",
		},
	},
];

function snapshot(
	definitionId: string,
	selectedRoles: string[] = [],
	testRunStarted = false,
): WorkflowSnapshot {
	return {
		schemaVersion: 1,
		workflowId: "test",
		revision: 1,
		definition: { id: definitionId, version: 106, digest: "digest" },
		status: "active",
		currentStep: "core.verification",
		step: {
			attempt: 1,
			activeRunIds: [],
			completedRunIds: [],
			selectedRoles,
			testRunStarted,
			results: [],
		},
		metadata: {
			repository: "",
			worktree: "",
			changeId: "test",
			branch: "",
			baseBranch: "",
			baseCommit: "",
			createdAt: "",
			updatedAt: "",
			stepEnteredAt: "",
		},
		routing: { defaultProfile: "", routes: [] },
		evidence: [],
		loopCounts: {},
		attention: [],
		developerDialogue: [],
	};
}

function testStep(
	id: string,
	actor: "agent" | "developer" | "system" = "system",
): StepDefinition {
	const contract = { id: "test.empty", version: 1, parse: () => null };
	const reduction = (value: WorkflowSnapshot) => ({
		snapshot: value,
		effects: [],
	});
	return {
		id,
		version: 1,
		label: id,
		actor,
		instructionAssets: [],
		instructionDigests: [],
		requirements: [],
		input: contract,
		output: contract,
		outcomes: ["next"],
		allowedEffects: [],
		enter: reduction,
		reduce: reduction,
	};
}

function expectedCandidateRoles(
	stepId: string,
	definitionId: string,
	fusionPlannerCount: number,
): string[] {
	if (stepId === "core.plan") return ["planner"];
	if (stepId === "fusion.plan")
		return Array.from(
			{ length: fusionPlannerCount },
			(_, index) => `planner-${index + 1}`,
		);
	if (stepId === "fusion.consolidate") return ["consolidator"];
	if (stepId === "core.implementation") return ["worker"];
	if (stepId === "core.triage") return ["triage"];
	if (stepId === "core.verification")
		return [
			"quality-verifier",
			"security-verifier",
			"performance-verifier",
			...(definitionId === "no-openspec" ? [] : ["openspec-verifier"]),
			"usability-verifier",
			"test-verifier",
		];
	if (stepId === "core.wiki")
		return [definitionId === "research" ? "research-wiki" : "wiki"];
	if (stepId === "core.research") return ["researcher"];
	if (stepId === "core.archive") return ["archive"];
	return [];
}

describe("workflow step behaviors", () => {
	test("preserves every registered definition and step digest", () => {
		const actual = registerBuiltins()
			.definitions()
			.map(({ id, version, digest, stepDigests }) => ({
				id,
				version,
				digest,
				stepDigests,
			}));
		expect(actual).toEqual(EXPECTED_DEFINITIONS);
	});

	test("resolves candidate roles through step behavior for every definition", () => {
		const registry = registerBuiltins();
		for (const definition of registry.definitions()) {
			for (const count of [0, 2, 3, 4, 5]) {
				const actual = rolesForDefinition(
					definition.id,
					definition.steps,
					registry,
					count,
				);
				for (const stepId of definition.steps) {
					if (registry.step(stepId).actor !== "agent") continue;
					const candidateRoles = stepBehavior(stepId).candidateRoles;
					expect(candidateRoles).toBeFunction();
					if (!candidateRoles)
						throw new Error(`missing candidate roles for ${stepId}`);
					expect(actual[stepId]).toEqual(
						expectedCandidateRoles(stepId, definition.id, count),
					);
					expect(actual[stepId]).toEqual(
						candidateRoles({
							definitionId: definition.id,
							fusionPlannerCount: count,
						}),
					);
				}
			}
		}
	});

	test("resolves active roles from representative snapshots", () => {
		const selected = ["security-verifier", "test-verifier"];
		expect(
			rolesForStep("core.verification", snapshot("openspec-full")),
		).toEqual(["quality-verifier"]);
		expect(
			rolesForStep("core.verification", snapshot("openspec-full", [], true)),
		).toEqual(["test-verifier"]);
		expect(
			rolesForStep("core.verification", snapshot("openspec-full", selected)),
		).toEqual(selected);
		expect(rolesForStep("core.wiki", snapshot("research"))).toEqual([
			"research-wiki",
		]);
		expect(rolesForStep("core.wiki", snapshot("openspec-full"))).toEqual([
			"wiki",
		]);
		const routing = (count: number) => ({
			defaultProfile: "",
			routes: Array.from({ length: count }, (_, index) => ({
				stepId: "fusion.plan",
				role: `planner-${index + 1}`,
				profile: {} as never,
			})),
		});
		expect(
			rolesForStep("fusion.plan", {
				...snapshot("openspec-fusion-full"),
				currentStep: "fusion.plan",
				routing: routing(2),
			}),
		).toEqual(["planner-1", "planner-2"]);
		expect(
			rolesForStep("fusion.plan", {
				...snapshot("openspec-fusion-full"),
				currentStep: "fusion.plan",
				routing: routing(5),
			}),
		).toEqual([
			"planner-1",
			"planner-2",
			"planner-3",
			"planner-4",
			"planner-5",
		]);
	});

	test("rejects invalid candidate roles and permits empty non-agent behavior", () => {
		const registry = new WorkflowRegistry(
			BUILTIN_EFFECTS,
			BUILTIN_CAPABILITIES,
		);
		expect(() =>
			registry.registerStep(testStep("missing.behavior", "agent")),
		).toThrow("missing step behavior for agent step missing.behavior");
		const emptyRegistry = new WorkflowRegistry(
			BUILTIN_EFFECTS,
			BUILTIN_CAPABILITIES,
		);
		emptyRegistry.registerStep({
			...testStep("bad.empty", "agent"),
			behavior: { roles: () => ["worker"], candidateRoles: () => [] },
		});
		expect(() =>
			emptyRegistry.registerWorkflow({
				id: "bad-empty",
				version: 1,
				label: "Empty candidates",
				initial: "bad.empty",
				terminal: ["bad.empty"],
				steps: ["bad.empty"],
				edges: [],
			}),
		).toThrow("empty candidate roles for agent step bad.empty");
		expect(() =>
			registry.registerStep({
				...testStep("bad.non-array", "agent"),
				behavior: {
					roles: () => ["worker"],
					candidateRoles: () => "worker" as never,
				},
			}),
		).toThrow("invalid candidate roles for bad.non-array");
		expect(
			registry.registerStep({
				...testStep("developer.empty", "developer"),
				behavior: {},
			}).actor,
		).toBe("developer");

		const contextRegistry = new WorkflowRegistry(
			BUILTIN_EFFECTS,
			BUILTIN_CAPABILITIES,
		);
		contextRegistry.registerStep({
			...testStep("context.agent", "agent"),
			behavior: {
				roles: () => ["worker"],
				candidateRoles: ({ definitionId }) =>
					definitionId === "context-flow" ? [] : ["worker"],
			},
		});
		expect(() =>
			contextRegistry.registerWorkflow({
				id: "context-flow",
				version: 1,
				label: "Context-sensitive behavior",
				initial: "context.agent",
				terminal: ["context.agent"],
				steps: ["context.agent"],
				edges: [],
			}),
		).toThrow("empty candidate roles for agent step context.agent");
	});

	test("permits behavior-free non-agent steps in a workflow", () => {
		expect(() =>
			assertStepBehaviorCoverage(["core.plan", "missing.step"]),
		).toThrow("missing step behavior: missing.step");
		const registry = new WorkflowRegistry(
			BUILTIN_EFFECTS,
			BUILTIN_CAPABILITIES,
		);
		registry.registerStep(testStep("behavior-free"));
		expect(
			registry.registerWorkflow({
				id: "behavior-free-workflow",
				version: 1,
				label: "Behavior-free workflow",
				initial: "behavior-free",
				terminal: ["behavior-free"],
				steps: ["behavior-free"],
				edges: [],
			}).steps,
		).toEqual(["behavior-free"]);
	});
});

describe("workflow step behavior hooks (move-step-semantics-to-behavior-hooks)", () => {
	function withMetadata(
		definitionId: string,
		overrides: Partial<WorkflowSnapshot["metadata"]> = {},
	): WorkflowSnapshot {
		const base = snapshot(definitionId);
		return { ...base, metadata: { ...base.metadata, ...overrides } };
	}
	function tempWorktree(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), "step-hooks-"));
	}
	function writeChange(
		worktree: string,
		changeId: string,
		files: Record<string, string>,
	): void {
		const root = path.join(worktree, "openspec", "changes", changeId);
		for (const [name, content] of Object.entries(files)) {
			const target = path.join(root, name);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		}
	}

	describe("entry-guard validateEvidence hooks", () => {
		test("core.plan and fusion.consolidate require non-empty planning artifacts and a scenario", () => {
			const worktree = tempWorktree();
			const changeId = "demo";
			const snap = withMetadata("openspec-full", { worktree, changeId });
			for (const stepId of ["core.plan", "fusion.consolidate"]) {
				expect(() =>
					stepBehavior(stepId).validateEvidence?.({ snapshot: snap }),
				).toThrow("planning artifact invalid: proposal.md");
				writeChange(worktree, changeId, {
					"proposal.md": "why",
					"design.md": "design",
					"tasks.md": "- [ ] task",
				});
				expect(() =>
					stepBehavior(stepId).validateEvidence?.({ snapshot: snap }),
				).toThrow("planning requires at least one OpenSpec scenario");
				writeChange(worktree, changeId, {
					"specs/x/spec.md": "#### Scenario: works\nok\n",
				});
				expect(() =>
					stepBehavior(stepId).validateEvidence?.({ snapshot: snap }),
				).not.toThrow();
				fs.rmSync(path.join(worktree, "openspec", "changes", changeId), {
					recursive: true,
					force: true,
				});
			}
		});

		test("core.implementation requires every OpenSpec task checked, except for no-openspec", () => {
			const worktree = tempWorktree();
			const changeId = "demo";
			writeChange(worktree, changeId, { "tasks.md": "- [ ] pending\n" });
			const openspecSnap = withMetadata("openspec-full", {
				worktree,
				changeId,
			});
			expect(() =>
				stepBehavior("core.implementation").validateEvidence?.({
					snapshot: openspecSnap,
				}),
			).toThrow("implementation requires completed OpenSpec tasks");
			const noOpenspecSnap = withMetadata("no-openspec", {
				worktree,
				changeId,
			});
			expect(() =>
				stepBehavior("core.implementation").validateEvidence?.({
					snapshot: noOpenspecSnap,
				}),
			).not.toThrow();
			writeChange(worktree, changeId, { "tasks.md": "- [x] done\n" });
			expect(() =>
				stepBehavior("core.implementation").validateEvidence?.({
					snapshot: openspecSnap,
				}),
			).not.toThrow();
		});

		test("core.archive requires the change directory moved into openspec/changes/archive", () => {
			const worktree = tempWorktree();
			const changeId = "demo";
			const snap = withMetadata("openspec-full", { worktree, changeId });
			writeChange(worktree, changeId, { "proposal.md": "why" });
			expect(() =>
				stepBehavior("core.archive").validateEvidence?.({ snapshot: snap }),
			).toThrow("archive move not found");
			fs.rmSync(path.join(worktree, "openspec", "changes", changeId), {
				recursive: true,
				force: true,
			});
			fs.mkdirSync(
				path.join(worktree, "openspec", "changes", "archive", changeId),
				{ recursive: true },
			);
			expect(() =>
				stepBehavior("core.archive").validateEvidence?.({ snapshot: snap }),
			).not.toThrow();
		});
	});

	describe("developerActions parity", () => {
		function ids(
			actions: ReturnType<
				NonNullable<ReturnType<typeof stepBehavior>["developerActions"]>
			>,
		): string[] {
			return actions.map((action) => action.id);
		}
		test("plan/review approval steps offer their fixed action set regardless of definition", () => {
			for (const definitionId of ["openspec-full", "research"]) {
				expect(
					ids(
						stepBehavior("core.wiki-approval").developerActions?.({
							snapshot: snapshot(definitionId),
						}) ?? [],
					),
				).toEqual(["approve-wiki", "review-comments"]);
			}
			expect(
				ids(
					stepBehavior("core.plan-approval").developerActions?.({
						snapshot: snapshot("openspec-full"),
					}) ?? [],
				),
			).toEqual(["approve-plan", "review-comments", "reject-plan"]);
			expect(
				ids(
					stepBehavior("core.developer-review").developerActions?.({
						snapshot: snapshot("openspec-full"),
					}) ?? [],
				),
			).toEqual(["approve-review", "review-comments"]);
		});
		test("core.research offers follow-up and close-research only while research is current", () => {
			expect(
				ids(
					stepBehavior("core.research").developerActions?.({
						snapshot: snapshot("research"),
					}) ?? [],
				),
			).toEqual(["research-follow-up", "close-research"]);
		});
		test("core.completed offers create-pr except for the five close-only definitions", () => {
			for (const definitionId of [
				"openspec-full",
				"openspec-apply",
				"no-openspec",
				"openspec-fusion-full",
			])
				expect(
					ids(
						stepBehavior("core.completed").developerActions?.({
							snapshot: snapshot(definitionId),
						}) ?? [],
					),
				).toEqual(["create-pr", "close"]);
			for (const definitionId of [
				"openspec-propose",
				"openspec-fusion-propose",
				"wiki",
				"wiki-comments",
				"research",
			])
				expect(
					ids(
						stepBehavior("core.completed").developerActions?.({
							snapshot: snapshot(definitionId),
						}) ?? [],
					),
				).toEqual(["close"]);
		});
		test("steps with no developer-facing action return an empty list", () => {
			for (const stepId of [
				"core.plan",
				"core.implementation",
				"core.triage",
				"core.verification",
				"core.wiki",
				"core.archive",
				"core.delivery",
				"core.closed",
				"fusion.plan",
				"fusion.consolidate",
			])
				expect(
					stepBehavior(stepId).developerActions?.({
						snapshot: snapshot("openspec-full"),
					}) ?? [],
				).toEqual([]);
		});
	});

	describe("context carry-over precedence (design D3)", () => {
		const edge = (from: string, to: string, loop = false) => ({
			from,
			outcome: "complete",
			to,
			...(loop ? { loop: { maxAttempts: 3 } } : {}),
		});
		function resolve(
			definitionId: string,
			e: ReturnType<typeof edge>,
			outcome: string,
			output: unknown,
			priorContext: unknown,
		) {
			return runtimeTest.resolveArrivalContext(
				(id) => stepBehavior(id),
				definitionId,
				e as never,
				outcome,
				output,
				priorContext as never,
				() => ({ concepts: [] }),
			);
		}
		test("no clause matches leaves context unset", () => {
			expect(
				resolve(
					"openspec-full",
					edge("core.plan", "core.plan-approval"),
					"complete",
					{ a: 1 },
					undefined,
				),
			).toBeUndefined();
		});
		test("a carriesOutputContext step takes the output verbatim", () => {
			expect(
				resolve(
					"openspec-full",
					edge("core.plan-approval", "core.implementation"),
					"approve",
					{ a: 1 },
					undefined,
				),
			).toEqual({ a: 1 });
		});
		test("acceptsCommentsContext requires the comments outcome", () => {
			// core.archive declares acceptsCommentsContext but not
			// carriesOutputContext, isolating this clause from clause C.
			expect(
				resolve(
					"openspec-full",
					edge("core.wiki-approval", "core.archive"),
					"comments",
					{ c: 1 },
					undefined,
				),
			).toEqual({ c: 1 });
			expect(
				resolve(
					"openspec-full",
					edge("core.wiki-approval", "core.archive"),
					"approve",
					{ c: 1 },
					undefined,
				),
			).toBeUndefined();
		});
		test("producesWikiVerificationContext wins over a plain output-carrying match", () => {
			expect(
				resolve(
					"openspec-full",
					edge("core.wiki", "core.wiki-approval"),
					"complete",
					{ ignored: true },
					undefined,
				),
			).toEqual({ concepts: [] });
		});
		test("wiki-comments definition override beats a carriesOutputContext match", () => {
			expect(
				resolve(
					"wiki-comments",
					edge("core.wiki-approval", "core.wiki", true),
					"comments",
					{ fresh: true },
					{ stale: true },
				),
			).toEqual({ stale: true });
		});
		test("a self-loop with defined output still takes the output, not the preserved prior context", () => {
			// This is the load-bearing quirk design D3 documents: the value
			// ternary only special-cases the definition override and the wiki
			// verification payload; every other matching clause (including the
			// generic loop self-edge) falls through to output-if-defined.
			expect(
				resolve(
					"openspec-full",
					edge("core.wiki", "core.wiki", true),
					"blocked",
					"retry message",
					{ stale: true },
				),
			).toBe("retry message");
		});
	});
});
