/**
 * Integration tests against fake-bin on PATH. Assert the composition layer calls
 * tool binaries by name (so PATH override works) and never via a shell, records
 * screenshots, and refuses input on focus mismatch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CLI,
  FAKE_BIN,
  runCli,
  spawnEnv,
  makeLogDir,
  readLog,
  entriesBy,
} from "./helpers.ts";

test("fake-bin resolves niri/grim/ydotool by name over real PATH", async () => {
  const dir = makeLogDir();
  const env = spawnEnv(dir, { FAKE_FOCUSED_ID: "42" });
  const res = await runCli(["type", "--text", "x", "--expect-window-id", "42", "--json"], env);
  assert.equal(res.code, 0, res.stderr);
  const logs = readLog(dir);
  assert.ok(logs.some((e) => e.tool === "niri" && e.argv[0] === "msg"), "niri fake used");
  assert.ok(logs.some((e) => e.tool === "ydotool"), "ydotool fake used");
  // the fake tools themselves live in this repo
  assert.ok(existsSync(join(FAKE_BIN, "ydotool")));
});

test("no shell interpolation: tricky text arrives byte-for-byte", async () => {
  const dir = makeLogDir();
  const tricky = 'echo "hi" && $(rm -rf /) ; `reboot` | cat > /tmp/x; *glob?[x]';
  const res = await runCli(["type", "--text", tricky, "--json"], spawnEnv(dir, { FAKE_FOCUSED_ID: "42" }));
  assert.equal(res.code, 0, res.stderr);
  const argv = entriesBy(readLog(dir), "ydotool", "type")[0].argv;
  assert.deepEqual(argv, ["type", tricky]);
});

test("screenshot captures a region and returns a usable path", async () => {
  const dir = makeLogDir();
  const out = join(dir, "region.png");
  const res = await runCli(["screenshot", "--region", "0,0,100,100", "--file", out, "--json"], spawnEnv(dir));
  assert.equal(res.code, 0, res.stderr);
  assert.equal(existsSync(out), true);
  const j = JSON.parse(res.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.file, out);

  // grim received an explicit geometry argument (no scraping of coords)
  const grim = entriesBy(readLog(dir), "grim")[0];
  assert.deepEqual(grim.argv.slice(0, 3), ["-g", "0,0 100x100", out]);
});

test("screenshot failure surfaces structured error", async () => {
  const dir = makeLogDir();
  const res = await runCli(["screenshot", "--file", join(dir, "x.png"), "--json"], spawnEnv(dir, { FAKE_GRIM_EXIT: "1" }));
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).error.code, "SCREENSHOT_FAILED");
});

test("focus mismatch refuses input end-to-end and blocks ydotool", async () => {
  const dir = makeLogDir();
  const res = await runCli(
    ["type", "--text", "irreversible things", "--expect-window-id", "42", "--json"],
    spawnEnv(dir, { FAKE_FOCUSED_ID: "13", FAKE_FOCUSED_APP: "org.hacker" }),
  );
  assert.equal(res.code, 1);
  const j = JSON.parse(res.stdout);
  assert.equal(j.error.code, "FOCUS_MISMATCH");
  assert.equal(j.actual.window_id, 13);
  assert.equal(entriesBy(readLog(dir), "ydotool").length, 0);
});

test("successful run returns machine-readable result; no typed text leaks", async () => {
  const dir = makeLogDir();
  const secret = "do-not-print-me-42";
  const res = await runCli(
    ["type", "--text", secret, "--expect-app-id", "org.example.App", "--json"],
    spawnEnv(dir, { FAKE_FOCUSED_ID: "42", FAKE_FOCUSED_APP: "org.example.App" }),
  );
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.includes(secret), false);
  assert.equal(res.stderr.includes(secret), false);
  const j = JSON.parse(res.stdout);
  assert.equal(j.verification.focus_assertion_passed, true);
});