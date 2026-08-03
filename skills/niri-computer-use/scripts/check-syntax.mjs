#!/usr/bin/env node
/**
 * Syntax check every TypeScript file under src/, bin/, tests/ and scripts/ via
 * `node --check`. This exercises the same type-stripping parser the runtime
 * uses; it does not perform full semantic type checking (no tsc, per design:
 * keep the skill zero-dependency).
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dirs = ["src", "bin", "tests", "scripts"];
const files = dirs.flatMap((d) => {
  const abs = join(root, d);
  return readdirSync(abs).map((f) => join(abs, f));
});
files.push(join(root, "scripts", "live-smoke.mjs"));

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${f}\n${r.stderr}`);
  } else {
    console.log(`ok ${f}`);
  }
}
if (failed > 0) {
  console.error(`${failed} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`checked ${files.length} file(s)`);