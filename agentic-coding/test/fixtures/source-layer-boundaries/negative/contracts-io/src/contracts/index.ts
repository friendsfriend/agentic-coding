// Negative fixture: a contract module reaching filesystem I/O.
import { readFileSync } from "node:fs";

export const read = readFileSync;
