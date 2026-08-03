#!/usr/bin/env node
/**
 * Conservative live smoke tests against a real Niri session.
 *
 * Safe by construction: queries state, takes a screenshot, runs dry-run input,
 * and intentionally fails a focus assertion. It never injects real input, never
 * clicks unknown UI, and never types into an application.
 *
 * Skipped (exit 0) when `niri msg version` cannot reach a compositor, so this
 * can run on headless CI.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

function sh(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8" });
}

const probe = sh("niri", ["msg", "version"]);
if (probe.status !== 0) {
  console.log("live-smoke: no niri session, skipping");
  process.exit(0);
}

const bin = new URL("../bin/niri-use", import.meta.url).pathname;
let failures = 0;

function expect(name, cond, extra = "") {
  if (cond) console.log(`ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name} ${extra}`);
  }
}

// 1. state query
const state = sh(bin, ["state", "--json"]);
expect("state query", state.status === 0, state.stderr);
let stateJson = null;
try {
  stateJson = JSON.parse(state.stdout);
} catch {
  /* handled below */
}
expect("state json parses", stateJson !== null && stateJson.ok === true);
expect("state reports focused window", stateJson && typeof stateJson.focused?.window_id === "number");

// 2. screenshot (no input, safe)
const shot = sh(bin, ["screenshot", "--json"]);
expect("screenshot", shot.status === 0, shot.stderr);
let shotJson = null;
try {
  shotJson = JSON.parse(shot.stdout);
} catch {
  /* handled below */
}
expect("screenshot json ok", shotJson?.ok === true && typeof shotJson.file === "string");
try {
  expect("screenshot file exists", statSync(shotJson.file).isFile(), shotJson.file);
} catch {
  expect("screenshot file exists", false);
}

// 3. dry-run input (must not touch ydotool)
const dry = sh(bin, ["type", "--text", "live smoke", "--dry-run", "--json"]);
expect("dry-run type", dry.status === 0, dry.stderr);

// 4. intentionally failing focus assertion (never reaches ydotool)
const mismatch = sh(bin, ["type", "--text", "x", "--expect-window-id", "999999", "--json", "--dry-run"]);
let misJson = null;
try {
  misJson = JSON.parse(mismatch.stdout);
} catch {
  /* handled below */
}
expect("focus mismatch rejected", mismatch.status === 1 && misJson?.error?.code === "FOCUS_MISMATCH", mismatch.stdout);

if (failures > 0) {
  console.error(`live-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log("live-smoke: all checks passed");