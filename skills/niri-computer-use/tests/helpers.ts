/**
 * Shared test harness: points the CLI at fake-bin (via PATH prefix), runs it as
 * a real subprocess, and reads back the exact argv recorded by the fakes.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..");
export const FAKE_BIN = join(ROOT, "fake-bin");
export const CLI = join(ROOT, "bin", "niri-use");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface LogEntry {
  tool: string;
  argv: string[];
}

export function makeLogDir(): string {
  return mkdtempSync(join(tmpdir(), "niri-use-test-"));
}

export function spawnEnv(logDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}`,
    FAKE_LOG: join(logDir, "log.jsonl"),
    HOME: logDir,
    ...extra,
  };
}

export function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export function readLog(logDir: string): LogEntry[] {
  const p = join(logDir, "log.jsonl");
  let raw = "";
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogEntry);
}

export function entriesBy(logs: LogEntry[], tool: string, sub?: string): LogEntry[] {
  return logs.filter(
    (e) => e.tool === tool && (sub === undefined || e.argv[0] === sub),
  );
}