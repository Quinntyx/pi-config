/**
 * Subprocess execution for niri-use.
 *
 * All child processes are spawned with explicit argv arrays and `shell: false`
 * (the default). Nothing is ever routed through a shell, so literal text cannot
 * be interpreted as shell syntax.
 */

import { spawn } from "node:child_process";

export interface RunOptions {
  /** Kill the child after this many ms. Default 15000. */
  timeoutMs?: number;
  /** Extra environment merged over process.env. Used to inject fake binaries. */
  env?: Record<string, string>;
}

export class RunError extends Error {
  code: number;
  stdout: string;
  stderr: string;
  argv: string[];
  constructor(message: string, code: number, stdout: string, stderr: string, argv: string[]) {
    super(message);
    this.name = "RunError";
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.argv = argv;
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Resolve the binary name for a tool, honoring explicit env overrides. */
export function toolBin(name: string, envOverride: string): string {
  return process.env[envOverride] || name;
}

/**
 * Run `argv` (argv[0] = program) without a shell.
 * Rejects NUL bytes before spawning; a NUL can never be a valid argv element.
 */
export function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.NIRI_USE_TIMEOUT_MS ?? 15000);
  for (const arg of argv) {
    if (arg.includes("\0")) {
      return Promise.reject(new Error(`NUL byte in argv element (${argv[0]} ...): refused`));
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new RunError(
          `${argv[0]} timed out after ${timeoutMs}ms`,
          -1,
          stdout,
          stderr,
          argv,
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Run and require exit code 0, throwing RunError otherwise. */
export async function mustRun(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const res = await run(argv, opts);
  if (res.code !== 0) {
    throw new RunError(
      `${argv[0]} exited with code ${res.code}`,
      res.code,
      res.stdout,
      res.stderr,
      argv,
    );
  }
  return res;
}
