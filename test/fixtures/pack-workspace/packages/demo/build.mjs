// Writes dist/, as a real package's build would. The pack-path test packs the
// package with and without running it.
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.js", "export const demo = 1;\n");
writeFileSync("dist/index.d.ts", "export declare const demo = 1;\n");
