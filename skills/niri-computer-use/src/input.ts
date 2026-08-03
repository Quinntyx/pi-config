/**
 * Guarded `ydotool` input injection.
 *
 * Everything reaches `ydotool` through explicit argv arrays (never a shell).
 * Text is kept literal, is never logged, and carries a maximum length. Focus
 * assertions are re-checked immediately before injection.
 */
import { run } from "./run.ts";
import {
  assertFocus as checkFocus,
  outputBounds,
  type Assertion,
  type FocusExpectation,
  type ReportOptions,
  type WindowInfo,
} from "./state.ts";

export interface InputOptions extends ReportOptions {
  dryRun?: boolean;
}

export const MAX_TEXT_DEFAULT = 10_000;

const BUTTONS: Record<string, number> = {
  left: 0x00,
  right: 0x01,
  middle: 0x02,
  side: 0x03,
  extra: 0x04,
  forward: 0x05,
  back: 0x05,
};

// Linux keycodes that must be explicitly allowed (KEY_POWER family).
const DANGEROUS_KEYCODES: Record<string, string> = {
  "116": "KEY_POWER",
  "142": "KEY_SLEEP",
  "143": "KEY_WAKEUP",
  "164": "KEY_POWER2",
};

function ydoBin(): string {
  return process.env.YDOTOOL_BIN || "ydotool";
}

export class AppError extends Error {
  code: string;
  extra: Record<string, unknown>;
  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.extra = extra;
  }
}

function err(code: string, message: string, extra: Record<string, unknown> = {}): AppError {
  return new AppError(code, message, extra);
}

function focusMismatch(expect: FocusExpectation, actual: WindowInfo | null): AppError {
  return err("FOCUS_MISMATCH", "focused window does not match expected target", {
    expected: {
      ...(expect.windowId !== undefined ? { window_id: expect.windowId } : {}),
      ...(expect.appId !== undefined ? { app_id: expect.appId } : {}),
    },
    actual: actual ? { window_id: actual.id, app_id: actual.app_id } : null,
  });
}

async function runYdo(argv: string[], o: InputOptions) {
  if (o.dryRun) return;
  const res = await run(argv, { env: o.env, timeoutMs: o.timeoutMs });
  if (res.code !== 0) {
    throw err(
      "YDO_FAILED",
      `${argv[0]} exited ${res.code}: ${res.stderr.trim() || "unknown error"}`,
      { argv },
    );
  }
}

async function preFlight(expect: FocusExpectation | undefined, o: InputOptions): Promise<Assertion> {
  if (!expect || (expect.windowId === undefined && expect.appId === undefined)) {
    return { passed: true, actual: null };
  }
  const focus = await checkFocus(expect, o);
  if (!focus.passed) throw focusMismatch(expect, focus.actual);
  return focus;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** Validate integer coordinates and, when possible, that they sit on an output. */
async function validateCoords(x: number, y: number, o: InputOptions): Promise<string | null> {
  if (!isInt(x) || !isInt(y)) return "coordinates must be integers";
  try {
    const bbox = await outputBounds(o);
    if (bbox) {
      if (
        x < bbox.x || y < bbox.y ||
        x >= bbox.x + bbox.width || y >= bbox.y + bbox.height
      ) {
        return `coordinates (${x},${y}) outside logical output bounds ` +
          `(${bbox.x},${bbox.y} ${bbox.width}x${bbox.height})`;
      }
    }
  } catch {
    // Outputs unavailable (e.g. offline): bounds check skipped, not fatal.
  }
  return null;
}

// ---------------------------------------------------------------------------
// type
// ---------------------------------------------------------------------------

export interface TypeOptions extends InputOptions {
  text: string;
  expect?: FocusExpectation;
  maxLength?: number;
  verbose?: boolean;
  unsafeDebug?: boolean;
}

/** Inject literal text via `ydotool type`. */
export async function typeText(o: TypeOptions): Promise<{ argv: string[]; focus: Assertion }> {
  if (o.text.includes("\0")) {
    throw err("NUL_BYTE", "text contains NUL bytes; refusing");
  }
  const max = o.maxLength ?? MAX_TEXT_DEFAULT;
  if (o.text.length > max) {
    throw err(
      "TEXT_TOO_LONG",
      `text length ${o.text.length} exceeds maximum ${max} (raise with --max-length)`,
      { length: o.text.length, max },
    );
  }
  const focus = await preFlight(o.expect, o);
  const argv = [ydoBin(), "type", o.text];
  await runYdo(argv, o);
  if (o.verbose) {
    const shown = o.unsafeDebug ? JSON.stringify(o.text) : "<redacted>";
    console.error(`niri-use: type ${o.text.length} chars ${shown}`);
  }
  return { argv, focus };
}

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

export interface KeyOptions extends InputOptions {
  tokens: string[];
  expect?: FocusExpectation;
  allowDangerous?: boolean;
}

/** Inject ydotool key tokens: "CODE" (tap) or "CODE:state". */
export async function keyTokens(o: KeyOptions): Promise<{ argv: string[]; focus: Assertion }> {
  if (o.tokens.length === 0) {
    throw err("EMPTY_KEYS", "at least one key token is required");
  }
  const bad = o.tokens.find((t) => !/^\d+(:\d+)?$/.test(t));
  if (bad) {
    throw err(
      "BAD_KEY_TOKEN",
      `invalid key token "${bad}": expected <KEYCODE> or <KEYCODE>:<state> (e.g. 29:1)`,
    );
  }
  if (!o.allowDangerous) {
    for (const t of o.tokens) {
      const code = t.split(":")[0];
      const name = DANGEROUS_KEYCODES[code];
      if (name) {
        throw err(
          "DANGEROUS_KEY",
          `${name} (${code}) requires --allow-dangerous`,
          { keycode: code },
        );
      }
    }
  }
  const focus = await preFlight(o.expect, o);
  const argv = [ydoBin(), "key", ...o.tokens];
  await runYdo(argv, o);
  return { argv, focus };
}

// ---------------------------------------------------------------------------
// pointer
// ---------------------------------------------------------------------------

export interface MoveOptions extends InputOptions {
  x: number;
  y: number;
}

/** Move pointer to absolute logical coordinates. */
export async function movePointer(o: MoveOptions): Promise<{ argv: string[] }> {
  const bad = await validateCoords(o.x, o.y, o);
  if (bad) throw err("BAD_COORDINATES", bad, { x: o.x, y: o.y });
  const argv = [ydoBin(), "mousemove", "--absolute", String(o.x), String(o.y)];
  await runYdo(argv, o);
  return { argv };
}

export interface ClickOptions extends InputOptions {
  x?: number;
  y?: number;
  button: string;
  expect?: FocusExpectation;
}

/** Optionally move, then click a validated button. Never auto-moves unless asked. */
export async function clickButton(o: ClickOptions): Promise<{ argv: string[]; focus: Assertion }> {
  const btnCode = parseButton(o.button);
  if (!/^0x[0-9a-f]{2}$/i.test(btnCode)) {
    throw err("BAD_BUTTON", `unknown mouse button "${o.button}"`, { button: o.button });
  }
  if (o.x !== undefined || o.y !== undefined) {
    if (o.x === undefined || o.y === undefined) {
      throw err("BAD_COORDINATES", "--x and --y must be given together");
    }
    const bad = await validateCoords(o.x, o.y, o);
    if (bad) throw err("BAD_COORDINATES", bad, { x: o.x, y: o.y });
  }
  const focus = await preFlight(o.expect, o);
  const argv: string[] = [];
  if (o.x !== undefined && o.y !== undefined) {
    const move = [ydoBin(), "mousemove", "--absolute", String(o.x), String(o.y)];
    argv.push(...move);
    await runYdo(move, o);
  }
  const click = [ydoBin(), "click", btnCode];
  argv.push(...click);
  await runYdo(click, o);
  return { argv, focus };
}

function parseButton(name: string): string {
  const lower = name.toLowerCase();
  const code = BUTTONS[lower];
  return code !== undefined
    ? `0x${code.toString(16).padStart(2, "0")}`
    : lower;
}