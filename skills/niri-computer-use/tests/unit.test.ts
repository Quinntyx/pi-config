/**
 * Unit tests for niri-use: argv fidelity, focus assertions, validation,
 * timeouts, failure propagation, JSON output, redaction.
 * Fake binaries come first on PATH; the fakes record exact argv.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { typeText, AppError, MAX_TEXT_DEFAULT } from "../src/input.ts";
import {
  CLI,
  runCli,
  spawnEnv,
  makeLogDir,
  readLog,
  entriesBy,
  type CliResult,
} from "./helpers.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const secret = "S3cr3t-Passw0rd!";

function typeOk(res: CliResult): boolean {
  return res.code === 0 && res.stdout.includes('"ok": true') && res.stdout.includes('"type"');
}

test("argv construction: literal text reaches ydotool as one argv element", async () => {
  const dir = makeLogDir();
  const env = spawnEnv(dir, { FAKE_FOCUSED_ID: "42" });
  const res = await runCli(["type", "--text", 'hello "quoted"; $(danger) `tick` | piped', "--expect-window-id", "42", "--json"], env);
  assert.equal(res.code, 0, res.stderr);
  const ydo = entriesBy(readLog(dir), "ydotool", "type");
  assert.equal(ydo.length, 1);
  assert.deepEqual(ydo[0].argv, ["type", 'hello "quoted"; $(danger) `tick` | piped']);
});

test("multiline text survives intact", async () => {
  const dir = makeLogDir();
  const res = await runCli(["type", "--text", "line1\nline2\nline3", "--json"], spawnEnv(dir, { FAKE_FOCUSED_ID: "42" }));
  assert.equal(res.code, 0, res.stderr);
  const argv = entriesBy(readLog(dir), "ydotool", "type")[0].argv;
  assert.deepEqual(argv, ["type", "line1\nline2\nline3"]);
});

test("unicode text survives intact", async () => {
  const dir = makeLogDir();
  const text = "héllo wörld — 世界 — 🎉";
  const res = await runCli(["type", "--text", text, "--json"], spawnEnv(dir, { FAKE_FOCUSED_ID: "42" }));
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(entriesBy(readLog(dir), "ydotool", "type")[0].argv, ["type", text]);
});

test("leading-dash text is not parsed as a flag", async () => {
  const dir = makeLogDir();
  const res = await runCli(["type", "--text=-n", "--json"], spawnEnv(dir, { FAKE_FOCUSED_ID: "42" }));
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(entriesBy(readLog(dir), "ydotool", "type")[0].argv, ["type", "-n"]);
});

test("over-maximum text is rejected", async () => {
  const dir = makeLogDir();
  const tooLong = "x".repeat(MAX_TEXT_DEFAULT + 1);
  const res = await runCli(["type", "--text", tooLong, "--json"], spawnEnv(dir, { FAKE_FOCUSED_ID: "42" }));
  assert.equal(res.code, 1);
  const j = JSON.parse(res.stdout);
  assert.equal(j.error.code, "TEXT_TOO_LONG");
  assert.equal(j.error.message.includes(String(MAX_TEXT_DEFAULT)), true);
});

test("NUL bytes are rejected at API level", async () => {
  await assert.rejects(
    typeText({ text: "a\0b", dryRun: true }),
    (e: unknown) => e instanceof AppError && e.code === "NUL_BYTE",
  );
});

test("focus assertion passes when focused window id matches", async () => {
  const dir = makeLogDir();
  const res = await runCli(
    ["type", "--text", "hi", "--expect-window-id", "42", "--json", "--dry-run"],
    spawnEnv(dir, { FAKE_FOCUSED_ID: "42" }),
  );
  assert.equal(res.code, 0, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.target.window_id, 42);
  assert.equal(j.verification.focus_assertion_passed, true);
});

test("focus assertion passes when app id matches", async () => {
  const dir = makeLogDir();
  const res = await runCli(
    ["type", "--text", "hi", "--expect-app-id", "org.example.App", "--json", "--dry-run"],
    spawnEnv(dir, { FAKE_FOCUSED_ID: "42", FAKE_FOCUSED_APP: "org.example.App" }),
  );
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).verification.focus_assertion_passed, true);
});

test("focus mismatch rejects input injection with structured error", async () => {
  const dir = makeLogDir();
  const res = await runCli(
    ["type", "--text", "hi", "--expect-window-id", "42", "--json", "--dry-run"],
    spawnEnv(dir, { FAKE_FOCUSED_ID: "57", FAKE_FOCUSED_APP: "org.other.App" }),
  );
  assert.equal(res.code, 1);
  const j = JSON.parse(res.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.error.code, "FOCUS_MISMATCH");
  assert.deepEqual(j.expected, { window_id: 42 });
  assert.deepEqual(j.actual, { window_id: 57, app_id: "org.other.App" });
  // and nothing reached ydotool
  assert.equal(entriesBy(readLog(dir), "ydotool").length, 0);
});

test("invalid coordinates are rejected (non-integer)", async () => {
  const dir = makeLogDir();
  const res = await runCli(["move", "--x", "1.5", "--y", "0", "--json"], spawnEnv(dir));
  assert.equal(res.code, 1);
  const j = JSON.parse(res.stdout);
  assert.ok(["BAD_ARG", "BAD_COORDINATES"].includes(j.error.code), j.error.code);
});

test("out-of-bounds coordinates are rejected", async () => {
  const dir = makeLogDir();
  const res = await runCli(["move", "--x", "999999", "--y", "0", "--json"], spawnEnv(dir));
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "BAD_COORDINATES");
});

test("invalid mouse button is rejected", async () => {
  const dir = makeLogDir();
  const res = await runCli(["click", "--x", "0", "--y", "0", "--button", "banana", "--json"], spawnEnv(dir));
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "BAD_BUTTON");
});

test("valid mouse button names map to ydotool hex codes", async () => {
  const dir = makeLogDir();
  const res = await runCli(["click", "--x", "10", "--y", "20", "--button", "right", "--json"], spawnEnv(dir));
  assert.equal(res.code, 0, res.stderr);
  const ydo = entriesBy(readLog(dir), "ydotool");
  assert.deepEqual(ydo[0].argv, ["mousemove", "--absolute", "10", "20"]);
  assert.deepEqual(ydo[1].argv, ["click", "0x01"]);
});

test("subprocess timeout produces structured TIMEOUT error", async () => {
  const dir = makeLogDir();
  const res = await runCli(
    ["move", "--x", "5", "--y", "5", "--timeout-ms", "300", "--json"],
    spawnEnv(dir, { FAKE_YDO_SLEEP_MS: "3000" }),
  );
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "TIMEOUT");
});

test("subprocess failure propagates with exit code", async () => {
  const dir = makeLogDir();
  const res = await runCli(
    ["move", "--x", "5", "--y", "5", "--json"],
    spawnEnv(dir, { FAKE_YDO_EXIT: "3" }),
  );
  assert.equal(res.code, 1);
  const j = JSON.parse(res.stdout);
  assert.equal(j.error.code, "YDO_FAILED");
  assert.equal(j.error.message.includes("3"), true);
});

test("JSON success output has stable shape and never contains typed text", async () => {
  const dir = makeLogDir();
  const res = await runCli(
    ["type", "--text", secret, "--expect-window-id", "42", "--json"],
    spawnEnv(dir, { FAKE_FOCUSED_ID: "42" }),
  );
  assert.equal(typeOk(res), true);
  assert.equal(res.stdout.includes(secret), false);
  const j = JSON.parse(res.stdout);
  assert.equal(j.operation, "type");
  assert.equal(j.verification.focus_assertion_passed, true);
});

test("JSON error output is machine readable", async () => {
  const dir = makeLogDir();
  const res = await runCli(
    ["type", "--text", "hi", "--expect-window-id", "42", "--json"],
    spawnEnv(dir, { FAKE_FOCUSED_ID: "9" }),
  );
  assert.equal(res.code, 1);
  const j = JSON.parse(res.stdout);
  assert.equal(j.ok, false);
  assert.equal(typeof j.error.code, "string");
  assert.equal(typeof j.error.message, "string");
});

test("verbose stderr redacts typed text; unsafe-debug reveals it", async () => {
  const dir = makeLogDir();
  const env = spawnEnv(dir, { FAKE_FOCUSED_ID: "42" });
  const v = await runCli(["type", "--text", secret, "--verbose", "--json"], env);
  assert.equal(v.code, 0, v.stderr);
  assert.equal(v.stderr.includes(secret), false);

  const u = await runCli(["type", "--text", secret, "--verbose", "--unsafe-debug", "--json"], env);
  assert.equal(u.code, 0, u.stderr);
  assert.equal(u.stderr.includes(secret), true);
});

test("dangerous keycode requires --allow-dangerous", async () => {
  const dir = makeLogDir();
  const blocked = await runCli(["key", "116", "--json", "--dry-run"], spawnEnv(dir));
  assert.equal(blocked.code, 1);
  assert.equal(JSON.parse(blocked.stdout).error.code, "DANGEROUS_KEY");

  const allowed = await runCli(["key", "116", "--allow-dangerous", "--json", "--dry-run"], spawnEnv(dir));
  assert.equal(allowed.code, 0, allowed.stderr);
});

test("malformed key tokens are rejected", async () => {
  const dir = makeLogDir();
  const res = await runCli(["key", "foo", "--json", "--dry-run"], spawnEnv(dir));
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "BAD_KEY_TOKEN");
});

test("key tokens build one ydotool argv without shell", async () => {
  const dir = makeLogDir();
  const res = await runCli(
    ["key", "29:1", "42:1", "30:1", "30:0", "42:0", "29:0", "--json"],
    spawnEnv(dir),
  );
  assert.equal(res.code, 0, res.stderr);
  const ydo = entriesBy(readLog(dir), "ydotool", "key");
  assert.equal(ydo.length, 1);
  assert.deepEqual(ydo[0].argv, ["key", "29:1", "42:1", "30:1", "30:0", "42:0", "29:0"]);
});

test("dry-run never invokes ydotool", async () => {
  const dir = makeLogDir();
  const res = await runCli(["type", "--text", "hi", "--dry-run", "--json"], spawnEnv(dir));
  assert.equal(res.code, 0, res.stderr);
  assert.equal(entriesBy(readLog(dir), "ydotool").length, 0);
});

test("help exits 0", async () => {
  const res = await runCli(["--help"], spawnEnv(makeLogDir()));
  assert.equal(res.code, 0);
  assert.equal(res.stdout.includes("niri-use"), true);
});

test("busy on builds canonical outline argv", async () => {
  const dir = makeLogDir();
  const res = await runCli(
    ["busy", "on", "--color", "#00ff00", "--thickness", "8", "--json"],
    spawnEnv(dir),
  );
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(entriesBy(readLog(dir), "layer-shell-rs")[0].argv, [
    "outline", "--show", "--color", "#00ff00", "--thickness", "8",
  ]);
  assert.equal(JSON.parse(res.stdout).action, "on");
});

test("busy on without flags relies on layer-shell-rs red defaults", async () => {
  const dir = makeLogDir();
  const res = await runCli(["busy", "on", "--json"], spawnEnv(dir));
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(entriesBy(readLog(dir), "layer-shell-rs")[0].argv, ["outline", "--show"]);
});

test("busy off/toggle/quit map to hide/toggle/quit", async () => {
  const dir = makeLogDir();
  for (const [action, flag] of [
    ["off", "--hide"],
    ["toggle", "--toggle"],
    ["quit", "--quit"],
  ] as const) {
    const res = await runCli(["busy", action, "--json"], spawnEnv(dir));
    assert.equal(res.code, 0, `${action}: ${res.stderr}`);
    assert.deepEqual(entriesBy(readLog(dir), "layer-shell-rs").at(-1)!.argv, ["outline", flag]);
  }
});

test("busy on failure is fatal (border is the safety indicator)", async () => {
  const dir = makeLogDir();
  const res = await runCli(["busy", "on", "--json"], spawnEnv(dir, { FAKE_LSR_EXIT: "1" }));
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "BUSY_ON_FAILED");
});

test("busy off failure is best-effort and warns", async () => {
  const dir = makeLogDir();
  const res = await runCli(["busy", "off", "--json"], spawnEnv(dir, { FAKE_LSR_EXIT: "1" }));
  assert.equal(res.code, 0, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.warn.includes("busy off failed"), true);
  assert.equal(typeof j.warn, "string");
});

test("busy dry-run executes nothing", async () => {
  const dir = makeLogDir();
  const res = await runCli(["busy", "on", "--dry-run", "--json"], spawnEnv(dir));
  assert.equal(res.code, 0, res.stderr);
  assert.equal(entriesBy(readLog(dir), "layer-shell-rs").length, 0);
});

test("busy rejects unknown action", async () => {
  const dir = makeLogDir();
  const res = await runCli(["busy", "maybe", "--json"], spawnEnv(dir));
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "BAD_ARG");
});

test("state --save writes a focus snapshot", async () => {
  const dir = makeLogDir();
  const snap = join(dir, "focus.json");
  const res = await runCli(
    ["state", "--save", snap, "--json"],
    spawnEnv(dir, { FAKE_FOCUSED_ID: "42", FAKE_FOCUSED_APP: "org.example.App" }),
  );
  assert.equal(res.code, 0, res.stderr);
  const j = JSON.parse(readFileSync(snap, "utf8"));
  assert.deepEqual(j, {
    window_id: 42,
    app_id: "org.example.App",
    title: "Fake Window",
    workspace_id: 1,
  });
});

test("restore re-focuses the saved window and verifies", async () => {
  const dir = makeLogDir();
  const env = spawnEnv(dir, { FAKE_FOCUSED_ID: "42" });
  // other window (57) is focused right now
  const otherEnv = spawnEnv(dir, { FAKE_FOCUSED_ID: "57" });
  const snap = join(dir, "focus.json");
  await writeFile(snap, JSON.stringify({ window_id: 42, app_id: "org.example.App", title: "Fake Window", workspace_id: 1 }));
  const res = await runCli(["restore", "--from", snap, "--json"], otherEnv);
  assert.equal(res.code, 0, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.restored, "window");
  assert.equal(j.target.window_id, 42);
  assert.equal(j.verification.focus_restored, true);
  // the focus-window action reached niri
  const acts = entriesBy(readLog(dir), "niri", "msg").filter((e) => e.argv[2] === "focus-window");
  assert.deepEqual(acts.at(-1)!.argv, ["msg", "action", "focus-window", "--id", "42"]);
});

test("restore falls back to the saved workspace when the window is gone", async () => {
  const dir = makeLogDir();
  const snap = join(dir, "focus.json");
  await writeFile(snap, JSON.stringify({ window_id: 9999, app_id: null, title: null, workspace_id: 1 }));
  const res = await runCli(["restore", "--from", snap, "--json"], spawnEnv(dir));
  assert.equal(res.code, 0, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.equal(j.restored, "workspace");
  assert.equal(j.verification.focus_restored, true);
});

test("restore fails when window and workspace are both gone", async () => {
  const dir = makeLogDir();
  const snap = join(dir, "focus.json");
  await writeFile(snap, JSON.stringify({ window_id: 9999, app_id: null, title: null, workspace_id: 9999 }));
  const res = await runCli(["restore", "--from", snap, "--json"], spawnEnv(dir));
  assert.equal(res.code, 1);
  const j = JSON.parse(res.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.error.code, "RESTORE_TARGET_GONE");
  assert.equal(j.error.message.includes("neither"), true);
});

test("restore dry-run executes nothing", async () => {
  const dir = makeLogDir();
  const snap = join(dir, "focus.json");
  await writeFile(snap, JSON.stringify({ window_id: 42, app_id: null, title: null, workspace_id: 1 }));
  const res = await runCli(["restore", "--from", snap, "--dry-run", "--json"], spawnEnv(dir));
  assert.equal(res.code, 0, res.stderr);
  const logs = readLog(dir);
  assert.equal(entriesBy(logs, "niri", "msg").filter((e) => e.argv[2] === "focus-window").length, 0);
});

test("restore reports missing snapshot file", async () => {
  const dir = makeLogDir();
  const res = await runCli(["restore", "--from", join(dir, "nope.json"), "--json"], spawnEnv(dir));
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "SNAPSHOT_MISSING");
});