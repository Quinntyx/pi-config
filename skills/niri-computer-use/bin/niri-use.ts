#!/usr/bin/env node
/**
 * niri-use — narrow guarded input shim for Niri/Wayland computer use.
 *
 * Subcommands: state, screenshot, type, key, click, move.
 * Raw `niri msg` and `grim` stay the primary composition layer; this tool only
 * guards `ydotool` injection and offers small state/screenshot conveniences.
 */
import {
  clickButton,
  keyTokens,
  movePointer,
  typeText,
  AppError,
  type FocusExpectation,
} from "../src/input.ts";
import { captureScreenshot } from "../src/capture.ts";
import { focusedWindow, windows } from "../src/state.ts";
import { RunError } from "../src/run.ts";
import { applyBusy, busySummary, type BusyAction } from "../src/busy.ts";
import { restoreFocus, type FocusSnapshot } from "../src/focus.ts";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const HELP = `niri-use — guarded input shim for Niri/Wayland computer use

Usage:
  niri-use state [--json]
  niri-use screenshot [--output NAME] [--region X,Y,W,H] [--file PATH] [--json]
  niri-use type --text TEXT [--expect-window-id N] [--expect-app-id APP]
                 [--max-length N] [--dry-run] [--json] [--verbose]
  niri-use key KEY... [--expect-window-id N] [--expect-app-id APP]
              [--allow-dangerous] [--dry-run] [--json]
              KEY: <KEYCODE> or <KEYCODE>:<state> (linux input-event-codes,
              e.g. KEY_LEFTSHIFT=42, KEY_LEFTCONTROL=29, KEY_A=30)
  niri-use move --x N --y N [--dry-run] [--json]
  niri-use click --x N --y N [--button left|right|middle|side|extra|forward|0xNN]
                 [--expect-window-id N] [--expect-app-id APP] [--dry-run] [--json]
  niri-use busy on|off|toggle|quit [--color #ff0000] [--thickness 4] [--dry-run] [--json]
  niri-use state --save PATH       # snapshot current focus for later restore
  niri-use restore [--from PATH]    # give the user their window back (default: saved focus)



Common:
  --json            machine-readable result on stdout
  --dry-run         plan only, execute nothing
  --timeout-ms N    subprocess timeout (default ${process.env.NIRI_USE_TIMEOUT_MS ?? 15000})
  --verbose         extra stderr logging (typed text is redacted)
  --unsafe-debug    with --verbose, print typed text (dev only)
  -h, --help

Env overrides: NIRI_BIN, GRIM_BIN, YDOTOOL_BIN, YDOTOOL_SOCKET (passed through).
Screenshots: \${XDG_RUNTIME_DIR:-/tmp}/pi-niri-computer-use/.
`;

interface CliOptions {
  json: boolean;
  dryRun: boolean;
  verbose: boolean;
  unsafeDebug: boolean;
  timeoutMs: number;
  env: Record<string, string>;
}

interface Parsed {
  op: string;
  args: Record<string, unknown>;
  opts: CliOptions;
}

const BOOLEAN_KEYS = new Set([
  "json",
  "dry-run",
  "verbose",
  "unsafe-debug",
  "help",
  "allow-dangerous",
]);

function isBoolFlag(key: string): boolean {
  return BOOLEAN_KEYS.has(key);
}

function parseArgs(argv: string[]): Parsed {
  const opts: CliOptions = {
    json: false,
    dryRun: false,
    verbose: false,
    unsafeDebug: false,
    timeoutMs: Number(process.env.NIRI_USE_TIMEOUT_MS ?? 15000),
    env: {},
  };
  const op = argv[0] ?? "";
  if (op === "" || op === "-h" || op === "--help") return { op: "help", args: {}, opts };

  const named: Record<string, string> = {};
  const flags = new Set<string>();
  const pos: string[] = [];
  const rest = argv.slice(1);

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") {
      pos.push(...rest.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) {
        if (isBoolFlag(key)) flags.add(key);
        else named[key] = a.slice(eq + 1);
      } else if (isBoolFlag(key)) {
        flags.add(key);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          named[key] = next;
          i++;
        } else {
          flags.add(key);
        }
      }
    } else {
      pos.push(a);
    }
  }

  const flag = (k: string): boolean => flags.has(k) || named[k] === "true";
  const get = (k: string): string | undefined => named[k];
  const num = (k: string): number | undefined => {
    const v = named[k];
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new AppError("BAD_ARG", `--${k} expects an integer, got "${v}"`, {k, v});
    return n;
  };

  if (flag("json")) opts.json = true;
  if (flag("dry-run")) opts.dryRun = true;
  if (flag("verbose")) opts.verbose = true;
  if (flag("unsafe-debug")) opts.unsafeDebug = true;
  const tm = num("timeout-ms");
  if (tm !== undefined) opts.timeoutMs = tm;
  for (const k of ["NIRI_BIN", "GRIM_BIN", "YDOTOOL_BIN", "LAYER_SHELL_RS_BIN"] as const) {
    if (process.env[k]) opts.env[k] = process.env[k]!;
  }

  const expect = (): FocusExpectation => ({
    ...(get("expect-window-id") !== undefined ? { windowId: Number(get("expect-window-id")) } : {}),
    ...(get("expect-app-id") !== undefined ? { appId: get("expect-app-id") } : {}),
  });

  switch (op) {
    case "state":
      return { op, args: { save: get("save") ?? null }, opts };
    case "restore":
      return { op, args: { from: get("from") ?? defaultFocusPath() }, opts };
    case "screenshot":
      return {
        op,
        args: {
          output: get("output") ?? null,
          region: parseRegion(get("region")),
          file: get("file") ?? null,
        },
        opts,
      };
    case "type": {
      const text = get("text");
      if (text === undefined) throw new AppError("MISSING_ARG", "--text is required");
      return {
        op,
        args: {
          text,
          expect: expect(),
          maxLength: num("max-length"),
          verbose: opts.verbose,
          unsafeDebug: opts.unsafeDebug,
        },
        opts,
      };
    }
    case "key":
      if (pos.length === 0) throw new AppError("MISSING_ARG", "at least one KEY token required");
      return {
        op,
        args: { tokens: pos, expect: expect(), allowDangerous: flag("allow-dangerous") },
        opts,
      };
    case "move":
      return { op, args: { x: num("x"), y: num("y") }, opts };
    case "click":
      return {
        op,
        args: { x: num("x"), y: num("y"), button: get("button") ?? "left", expect: expect() },
        opts,
      };
    case "busy": {
      const action = pos[0] as BusyAction | undefined;
      if (action === undefined || !["on", "off", "toggle", "quit"].includes(action)) {
        throw new AppError("BAD_ARG", "busy expects one of: on | off | toggle | quit");
      }
      return {
        op,
        args: {
          action,
          color: get("color") ?? null,
          thickness: num("thickness"),
        },
        opts,
      };
    }
    default:
      throw new AppError("UNKNOWN_OP", `unknown operation "${op}"`, { op });
  }
}

function parseRegion(
  s: string | undefined,
): { x: number; y: number; width: number; height: number } | null {
  if (s === undefined) return null;
  const m = /^(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/.exec(s.trim());
  if (!m) throw new AppError("BAD_ARG", `--region expects X,Y,W,H (e.g. 0,0,1920,1080), got "${s}"`);
  const x = Number(m[1]);
  const y = Number(m[2]);
  const w = Number(m[3]);
  const h = Number(m[4]);
  if (w <= 0 || h <= 0) throw new AppError("BAD_ARG", "--region width/height must be positive");
  return { x, y, width: w, height: h };
}

function targetOf(e: FocusExpectation | undefined): Record<string, unknown> | null {
  if (!e || (e.windowId === undefined && e.appId === undefined)) return null;
  return {
    ...(e.windowId !== undefined ? { window_id: e.windowId } : {}),
    ...(e.appId !== undefined ? { app_id: e.appId } : {}),
  };
}

function human(msg: string): void {
  process.stderr.write(`niri-use: ${msg}\n`);
}

function planLine(dryRun: boolean, json: boolean, summary: string): void {
  if (dryRun && !json) {
    human(`dry-run: would run: ${summary}`);
  }
}

function defaultFocusPath(): string {
  const dir = `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/pi-niri-computer-use`;
  return `${dir}/focus.json`;
}


async function main(): Promise<void> {
  const { op, args, opts } = parseArgs(process.argv.slice(2));
  if (op === "help") {
    process.stdout.write(HELP);
    return;
  }

  let result: Record<string, unknown>;
  switch (op) {
    case "state": {
      const [focused, ws] = await Promise.all([
        focusedWindow({ env: opts.env }),
        windows({ env: opts.env }),
      ]);
      result = {
        ok: true,
        operation: "state",
        focused: focused
          ? { window_id: focused.id, app_id: focused.app_id, title: focused.title }
          : null,
        windows: ws.map((w) => ({
          window_id: w.id,
          app_id: w.app_id,
          title: w.title,
          focused: w.is_focused === true,
        })),
      };
      const save = args.save as string | null;
      if (save) {
        const snap = {
          window_id: focused?.id ?? null,
          app_id: focused?.app_id ?? null,
          title: focused?.title ?? null,
          workspace_id: focused?.workspace_id ?? null,
        };
        await mkdir(dirname(save), { recursive: true });
        await writeFile(save, JSON.stringify(snap, null, 2) + "\n", "utf8");
      }
      break;
    }
    case "restore": {
      const from = args.from as string;
      let raw: string;
      try {
        raw = await readFile(from, "utf8");
      } catch {
        throw new AppError("SNAPSHOT_MISSING", `focus snapshot not found at ${from}`);
      }
      const snap = JSON.parse(raw) as FocusSnapshot;
      if (typeof snap?.window_id === "undefined" || typeof snap?.workspace_id === "undefined") {
        throw new AppError("SNAPSHOT_BAD", `focus snapshot at ${from} has an invalid shape`);
      }
      if (opts.dryRun) {
        planLine(opts.dryRun, opts.json, `restore focus from ${from}`);
        result = { ok: true, operation: "restore", dry_run: true };
      } else {
        const r = await restoreFocus(snap, { env: opts.env, timeoutMs: opts.timeoutMs });
        result = {
          ok: true,
          operation: "restore",
          restored: r.mode,
          target: {
            ...(r.window_id !== undefined ? { window_id: r.window_id } : {}),
            ...(r.workspace_id !== undefined ? { workspace_id: r.workspace_id } : {}),
          },
          verification: { focus_restored: r.focus_verified },
        };
      }
      break;
    }
    case "screenshot": {
      const shot = await captureScreenshot({
        mode: args.region as { x: number; y: number; width: number; height: number } | null,
        output: args.output as string | null | undefined,
        file: args.file as string | null | undefined,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
      });
      result = {
        ok: shot.ok,
        operation: "screenshot",
        file: shot.file,
        ...(shot.error ? { error: shot.error } : {}),
      };
      if (!shot.ok) throw new AppError(
        shot.error?.code ?? "SCREENSHOT_FAILED",
        shot.error?.message ?? "screenshot failed",
      );
      break;
    }
    case "type": {
      const r = await typeText({
        text: args.text as string,
        expect: args.expect as FocusExpectation | undefined,
        maxLength: args.maxLength as number | undefined,
        dryRun: opts.dryRun,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
        verbose: opts.verbose,
        unsafeDebug: opts.unsafeDebug,
      });
      const tlen = (args.text as string).length;
      planLine(opts.dryRun, opts.json, `ydotool type <${tlen} chars, redacted>`);
      result = {
        ok: true,
        operation: "type",
        target: targetOf(args.expect as FocusExpectation | undefined),
        verification: { focus_assertion_passed: r.focus.passed },
      };
      break;
    }
    case "key": {
      const r = await keyTokens({
        tokens: args.tokens as string[],
        expect: args.expect as FocusExpectation | undefined,
        allowDangerous: Boolean(args.allowDangerous),
        dryRun: opts.dryRun,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
      });
      planLine(opts.dryRun, opts.json, `ydotool key ${(args.tokens as string[]).join(" ")}`);
      result = {
        ok: true,
        operation: "key",
        target: targetOf(args.expect as FocusExpectation | undefined),
        verification: { focus_assertion_passed: r.focus.passed },
      };
      break;
    }
    case "move": {
      const x = args.x as number | undefined;
      const y = args.y as number | undefined;
      if (x === undefined || y === undefined) throw new AppError("MISSING_ARG", "--x and --y are required");
      const r = await movePointer({ x, y, dryRun: opts.dryRun, env: opts.env, timeoutMs: opts.timeoutMs });
      planLine(opts.dryRun, opts.json, `ydotool mousemove --absolute ${x} ${y}`);
      result = { ok: true, operation: "move" };
      break;
    }
    case "click": {
      const x = args.x as number | undefined;
      const y = args.y as number | undefined;
      if (x === undefined || y === undefined) throw new AppError("MISSING_ARG", "--x and --y are required");
      const r = await clickButton({
        x,
        y,
        button: args.button as string,
        expect: args.expect as FocusExpectation | undefined,
        dryRun: opts.dryRun,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
      });
      const btn = args.button as string;
      planLine(opts.dryRun, opts.json, `ydotool click ${btn}${x !== undefined && y !== undefined ? " after mousemove --absolute " + x + " " + y : ""}`);
      result = {
        ok: true,
        operation: "click",
        target: targetOf(args.expect as FocusExpectation | undefined),
        verification: { focus_assertion_passed: r.focus.passed },
      };
      break;
    }
    case "busy": {
      const action = args.action as BusyAction;
      const r = await applyBusy({
        action,
        color: args.color as string | null | undefined ?? undefined,
        thickness: args.thickness as number | undefined,
        dryRun: opts.dryRun,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
      });
      planLine(opts.dryRun, opts.json, busySummary(action));
      result = {
        ok: r.ok,
        operation: "busy",
        action,
        ...(r.warn ? { warn: r.warn } : {}),
      };
      break;
    }
    default:
      throw new AppError("UNKNOWN_OP", `unknown operation "${op}"`);
  }

  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function errorExit(e: unknown): void {
  const json = process.argv.includes("--json");
  if (e instanceof AppError || e instanceof RunError) {
    const err = e instanceof AppError ? e : { code: e.message.includes("timed out") ? "TIMEOUT" : "SUBPROCESS_FAILED", message: e.message };
    if (json) {
      const out: Record<string, unknown> = {
        ok: false,
        operation: process.argv[2] ?? "?",
        error: { code: err.code, message: err.message },
      };
      if (e instanceof AppError) {
        const extra = e.extra as { expected?: unknown; actual?: unknown };
        if (extra.expected !== undefined) out.expected = extra.expected;
        if (extra.actual !== undefined) out.actual = extra.actual;
      }
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    } else {
      human(`${err.code}: ${err.message}`);
    }
    process.exitCode = 1;
  } else {
    human(`internal error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

main().catch(errorExit);