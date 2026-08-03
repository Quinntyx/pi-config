/**
 * Niri state inspection and focus assertions.
 *
 * JSON is parsed from `niri msg -j ...` output; human-formatted output is never
 * scraped. The `niri` binary name can be overridden with NIRI_BIN (useful for
 * tests using fake-bin).
 */
import { mustRun, toolBin, type RunOptions } from "./run.ts";

export interface WindowInfo {
  id: number;
  app_id: string;
  title: string;
  pid?: number;
  workspace_id?: number;
  is_focused?: boolean;
}

export interface FocusExpectation {
  windowId?: number;
  appId?: string;
}

const NIRI = () => toolBin("niri", "NIRI_BIN");

function parseWindow(json: string): WindowInfo | null {
  if (!json || !json.trim()) return null;
  const raw = JSON.parse(json);
  if (!raw || typeof raw !== "object") return null;
  return {
    id: raw.id,
    app_id: raw.app_id ?? "",
    title: raw.title ?? "",
    pid: raw.pid,
    workspace_id: raw.workspace_id,
    is_focused: raw.is_focused,
  };
}

/** `niri msg -j focused-window` -> window or null when nothing focused. */
export async function focusedWindow(opts: ReportOptions = {}): Promise<WindowInfo | null> {
  const res = await mustRun([NIRI(), "msg", "-j", "focused-window"], subOpts(opts));
  return parseWindow(res.stdout);
}

/** `niri msg -j windows` -> array of all windows. */
export async function windows(opts: ReportOptions = {}): Promise<WindowInfo[]> {
  const res = await mustRun([NIRI(), "msg", "-j", "windows"], subOpts(opts));
  const arr = JSON.parse(res.stdout || "[]");
  return Array.isArray(arr) ? arr.map((w: Record<string, unknown>) => ({
    id: w.id as number,
    app_id: (w.app_id as string) ?? "",
    title: (w.title as string) ?? "",
    pid: w.pid as number | undefined,
    workspace_id: w.workspace_id as number | undefined,
    is_focused: w.is_focused as boolean | undefined,
  })) : [];
}

export interface WorkspaceInfo {
  id: number;
  idx?: number;
  output?: string;
  name?: string | null;
  is_active?: boolean;
  is_focused?: boolean;
}

/** `niri msg -j workspaces` -> array of all workspaces. */
export async function workspaces(opts: ReportOptions = {}): Promise<WorkspaceInfo[]> {
  const res = await mustRun([NIRI(), "msg", "-j", "workspaces"], subOpts(opts));
  const arr = JSON.parse(res.stdout || "[]");
  return Array.isArray(arr) ? arr.map((w: Record<string, unknown>) => ({
    id: w.id as number,
    idx: w.idx as number | undefined,
    output: w.output as string | undefined,
    name: w.name as string | null | undefined,
    is_active: w.is_active as boolean | undefined,
    is_focused: w.is_focused as boolean | undefined,
  })) : [];
}

/** `niri msg action focus-window --id N`. */
export async function focusWindowById(id: number, opts: ReportOptions = {}): Promise<void> {
  await mustRun([NIRI(), "msg", "action", "focus-window", "--id", String(id)], subOpts(opts));
}

/** `niri msg action focus-workspace ID`. */
export async function focusWorkspaceById(id: number, opts: ReportOptions = {}): Promise<void> {
  await mustRun([NIRI(), "msg", "action", "focus-workspace", String(id)], subOpts(opts));
}

/** Focus assertion result. */
export interface Assertion {
  passed: boolean;
  actual: WindowInfo | null;
}

/**
 * Assert the currently focused window matches the expectation.
 * With no expectation, always passes.
 */
export async function assertFocus(
  expect: FocusExpectation,
  opts: ReportOptions = {},
): Promise<Assertion> {
  const wantsWin = expect.windowId !== undefined;
  const wantsApp = expect.appId !== undefined;
  if (!wantsWin && !wantsApp) return { passed: true, actual: null };
  const w = await focusedWindow(opts);
  let ok = true;
  if (wantsWin) ok = ok && (w !== null && w.id === expect.windowId);
  if (wantsApp) ok = ok && (w !== null && w.app_id === expect.appId);
  return { passed: ok, actual: w };
}

export interface ReportOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}

function subOpts(o: ReportOptions): RunOptions {
  return { env: o.env, timeoutMs: o.timeoutMs };
}


/** Combined bounding box (in logical pixels) of all niri outputs. */
export async function outputBounds(opts: ReportOptions = {}): Promise<
  { x: number; y: number; width: number; height: number } | null
> {
  const res = await mustRun([NIRI(), "msg", "-j", "outputs"], subOpts(opts));
  const parsed = JSON.parse(res.stdout || "{}");
  const rects = Object.values(parsed)
    .map((o) => (o as { logical?: { x: number; y: number; width: number; height: number } }).logical)
    .filter((l): l is NonNullable<typeof l> => Boolean(l));
  if (rects.length === 0) return null;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}