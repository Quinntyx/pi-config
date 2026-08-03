/**
 * Screenshots via `grim`. Captures the default screen, a named output, or an
 * explicit logical-pixel region.
 *
 * Niri 26.04 does not expose absolute on-screen coordinates for tiled windows,
 * so a "focused window rect" is not derivable reliably and is therefore not
 * offered here; use a full output or an explicit region instead.
 */
import { mkdir, stat } from "node:fs/promises";
import { run } from "./run.ts";
import type { ReportOptions } from "./state.ts";


export interface ScreenshotOptions extends ReportOptions {
  mode?: { x: number; y: number; width: number; height: number } | null;
  output?: string | null;
  file?: string | null;
}

export interface ScreenshotResult {
  ok: boolean;
  file: string;
  error?: { code: string; message: string };
}

function grimBin(): string {
  return process.env.GRIM_BIN || "grim";
}

export async function captureScreenshot(o: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const dir = `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/niri-computer-use`;
  await mkdir(dir, { recursive: true });
  const file = o.file ?? `${dir}/shot-${Date.now()}.png`;
  const argv = [grimBin()];
  if (o.output) argv.push("-o", o.output);
  if (o.mode) argv.push("-g", `${o.mode.x},${o.mode.y} ${o.mode.width}x${o.mode.height}`);
  argv.push(file);
  const res = await run(argv, { env: o.env, timeoutMs: o.timeoutMs });
  if (res.code !== 0) {
    return {
      ok: false,
      file,
      error: {
        code: "SCREENSHOT_FAILED",
        message: `grim exited ${res.code}: ${res.stderr.trim() || "unknown error"}`,
      },
    };
  }
  let isFile = false;
  try {
    isFile = (await stat(file)).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    return {
      ok: false,
      file,
      error: {
        code: "SCREENSHOT_MISSING",
        message: `grim exited 0 but produced no file at ${file}`,
      },
    };
  }
  return { ok: true, file };
}