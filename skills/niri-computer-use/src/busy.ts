/**
 * "Busy" indicator: a red fullscreen outline drawn with `layer-shell-rs
 * outline`. Shown while Pi is performing computer-use actions so the user
 * knows not to touch the machine, and hidden when actions are complete.
 */
import { run } from "./run.ts";
import { AppError } from "./input.ts";

export type BusyAction = "on" | "off" | "toggle" | "quit";

export interface BusyOptions {
  action: BusyAction;
  color?: string;
  thickness?: number;
  dryRun?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface BusyResult {
  argv: string[];
  ok: boolean;
  /** Non-empty when the subprocess failed and the action could not be applied. */
  warn?: string;
}

function bin(): string {
  return process.env.LAYER_SHELL_RS_BIN || "layer-shell-rs";
}

export const defaultColor = "#ff0000";
export const defaultThickness = 4;

function buildArgv(action: BusyAction, color?: string, thickness?: number): string[] {
  const argv = [bin(), "outline"];
  switch (action) {
    case "on":
      argv.push("--show");
      if (color) argv.push("--color", color);
      if (thickness !== undefined) argv.push("--thickness", String(thickness));
      break;
    case "off":
      argv.push("--hide");
      break;
    case "toggle":
      argv.push("--toggle");
      break;
    case "quit":
      argv.push("--quit");
      break;
  }
  return argv;
}

export function busySummary(action: BusyAction): string {
  return `layer-shell-rs outline ${action}`;
}

/**
 * Apply a busy-border action.
 * - `on` is safety-critical (a border that fails to appear means the indicator
 *   is not protecting the user): failures raise a structured AppError.
 * - `off`/`toggle`/`quit` are best-effort cleanup: failures are reported as a
 *   warning rather than an error so a failed hide never masks the result.
 */
export async function applyBusy(o: BusyOptions): Promise<BusyResult> {
  const argv = buildArgv(o.action, o.color, o.thickness);
  if (o.dryRun) return { argv, ok: true };
  const res = await run(argv, { env: o.env, timeoutMs: o.timeoutMs });
  if (res.code !== 0) {
    const msg = `busy ${o.action} failed (${bin()} exit ${res.code}): ${res.stderr.trim() || "unknown error"}`;
    if (o.action === "on") {
      throw new AppError("BUSY_ON_FAILED", `${msg} — do not proceed with desktop actions until the border shows`);
    }
    return { argv, ok: false, warn: msg };
  }
  return { argv, ok: true };
}