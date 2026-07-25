/**
 * bacon.ts — Live Rust diagnostics (bacon) in the footer, left of the `ctx` cluster.
 *
 * When bacon is installed AND the git root of the current project contains a
 * `Cargo.toml`, this extension spawns `bacon -s --headless --no-listen` against
 * that root and renders a compact status segment immediately to the LEFT of the
 * context-usage cluster on the footer stats line:
 *
 *     ... ↑12k ↓3k $0.001  bacon:check 2e 1w  12.3%/200k ...  model name
 *                                  ^^^^^^^^^^^^  <- injected here, left of ctx
 *
 * It follows project switches (respawns bacon when the git root changes) and
 * cleans up the child process on session shutdown / process exit.
 *
 * Implementation notes:
 *  - pi exposes no "add a footer segment" hook; `ctx.ui.setFooter` fully replaces
 *    the footer. So we wrap pi's own `FooterComponent` (fed a thin session shim
 *    built from `ctx`) for a zero-drift footer, then splice the bacon segment
 *    into its stats line right before the context% token.
 *  - bacon's headless summary line is the LAST line of each report and carries
 *    colored badges: [gray]project[/][pink]job[/]([red]N errors[/])([amber]N warnings[/]).
 *    We parse counts from the ANSI-stripped text and the job from the pink badge.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI, type Theme } from "@earendil-works/pi-tui";

// ── bacon state ──────────────────────────────────────────────────────────────

interface BaconStatus {
	active: boolean; // running against a rust project
	building: boolean; // a build is in progress
	job?: string;
	errors?: number;
	warnings?: number;
	failed?: boolean; // bacon process died / errored
}

let status: BaconStatus = { active: false, building: false };
let gitRoot: string | null = null;
let baconProc: ReturnType<typeof spawn> | null = null;
let renderTui: TUI | null = null;
let baconInstalled: boolean | null = null;
let lastCwd: string | undefined;

function setStatus(patch: Partial<BaconStatus>) {
	const next = { ...status, ...patch };
	// Only react to meaningful changes to avoid render storms during a build.
	const changed =
		next.active !== status.active ||
		next.building !== status.building ||
		next.job !== status.job ||
		next.errors !== status.errors ||
		next.warnings !== status.warnings ||
		next.failed !== status.failed;
	status = next;
	if (changed) renderTui?.requestRender();
}

// ── bacon process management ─────────────────────────────────────────────────

function isBaconInstalled(): boolean {
	if (baconInstalled !== null) return baconInstalled;
	try {
		const r = spawnSync("bacon", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
		baconInstalled = r.status === 0 || /bacon/i.test((r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? ""));
	} catch {
		baconInstalled = false;
	}
	return baconInstalled;
}

function detectGitRoot(cwd: string): string | null {
	try {
		const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (r.status !== 0) return null;
		const root = (r.stdout?.toString() ?? "").trim();
		return root && existsSync(join(root, "Cargo.toml")) ? root : null;
	} catch {
		return null;
	}
}

function stopBacon() {
	if (baconProc) {
		try {
			baconProc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		baconProc = null;
	}
}

const SUMMARY_PINK = "\x1b[48;5;204m"; // bacon's job-badge background
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

function stripAnsi(s: string): string {
	return s.replace(OSC, "").replace(ANSI, "");
}

function parseSummary(raw: string): { job: string; errors: number; warnings: number } | null {
	if (!raw.includes(SUMMARY_PINK)) return null;
	// Job name = text inside the pink job-badge, up to the next reset.
	const jobMatch = raw.match(/\x1b\[48;5;204m([\s\S]*?)\x1b\[0m/);
	const job = jobMatch ? stripAnsi(jobMatch[1]).trim() || "check" : "check";
	const text = stripAnsi(raw);
	const e = text.match(/(\d+)\s+errors?\b/i);
	const w = text.match(/(\d+)\s+warnings?\b/i);
	return { job, errors: e ? Number(e[1]) : 0, warnings: w ? Number(w[1]) : 0 };
}

function startBacon(root: string) {
	stopBacon();
	let proc: ReturnType<typeof spawn>;
	try {
		proc = spawn("bacon", ["-s", "--headless", "--no-listen"], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		setStatus({ active: false, failed: true });
		return;
	}
	baconProc = proc;
	gitRoot = root;

	let buf = "";
	const onChunk = (chunk: Buffer | string) => {
		buf += chunk.toString();
		let idx: number;
		while ((idx = buf.lastIndexOf("\n")) >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			handleLine(line);
		}
	};

	const handleLine = (line: string) => {
		// Build-in-progress markers (before the next summary line lands).
		if (/\b(Checking|Compiling|Building|Running|Documenting|Fresh)\b/.test(stripAnsi(line))) {
			setStatus({ building: true });
		}
		const parsed = parseSummary(line);
		if (parsed) {
			setStatus({ building: false, job: parsed.job, errors: parsed.errors, warnings: parsed.warnings });
		}
	};

	proc.stdout?.on("data", onChunk);
	proc.stderr?.on("data", onChunk);
	proc.on("error", () => setStatus({ active: false, failed: true }));
	proc.on("exit", (code) => {
		if (baconProc === proc) baconProc = null;
		if (code !== null && code !== 0 && status.active) setStatus({ failed: true });
	});

	setStatus({ active: true, building: true, failed: false });
}

function reconcile(ctx: ExtensionContext) {
	if (ctx.mode !== "tui") return;
	if (!isBaconInstalled()) return;
	if (ctx.cwd === lastCwd) return; // already probed this cwd
	lastCwd = ctx.cwd;
	const root = detectGitRoot(ctx.cwd);
	if (root === gitRoot) return; // unchanged (incl. both null)
	if (!root) {
		stopBacon();
		gitRoot = null;
		setStatus({ active: false, building: false, job: undefined, errors: undefined, warnings: undefined, failed: false });
		return;
	}
	startBacon(root);
}

// ── footer segment rendering ─────────────────────────────────────────────────

function renderBaconSegment(theme: Theme): string {
	if (!status.active) return "";
	if (status.failed) return `${theme.fg("dim", "bacon")}${theme.fg("error", " ✗")}`;
	const job = status.job ? `:${status.job.slice(0, 12)}` : "";
	let seg = `${theme.fg("dim", "bacon")}${job ? theme.fg("muted", job) : ""}`;
	if (status.errors && status.errors > 0) {
		seg += ` ${theme.fg("error", `${status.errors}e`)}`;
	}
	if (status.warnings && status.warnings > 0) {
		seg += ` ${theme.fg("warning", `${status.warnings}w`)}`;
	}
	if (status.building) {
		seg += ` ${theme.fg("accent", "⋯")}`;
	} else if (!status.errors && !status.warnings) {
		seg += ` ${theme.fg("success", "✓")}`;
	}
	return seg;
}

/** Insert `seg` into the stats line just before the context% cluster. */
function injectBeforeCtx(statsLine: string, seg: string, width: number): string {
	if (!seg) return statsLine;
	const vis = stripAnsi(statsLine);
	const m = vis.match(/(?:[0-9]+(?:\.[0-9]+)?%|\?)\/[0-9.]+[kKMm]*(?: \(auto\))?/);
	if (!m || m.index === undefined) return statsLine; // ctx cluster not present (narrow) → skip

	// Map the visible match start back to a raw index, then back up over the
	// ANSI color codes that precede the ctx cluster so we split before its color.
	const map = visibleToRawMap(statsLine);
	let r = map[m.index] ?? statsLine.length;
	let prefix = statsLine.slice(0, r);
	let trail;
	while ((trail = prefix.match(/(\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\))$/))) {
		r -= trail[0].length;
		prefix = statsLine.slice(0, r);
	}

	const insert = `\x1b[0m ${seg} \x1b[0m`;
	let out = statsLine.slice(0, r) + insert + statsLine.slice(r);
	if (visibleWidth(out) > width) out = truncateToWidth(out, width, "…");
	return out;
}

function visibleToRawMap(raw: string): number[] {
	const map: number[] = [];
	let i = 0;
	while (i < raw.length) {
		const rest = raw.slice(i);
		const osc = rest.match(/^\x1b\][^\x07]*(?:\x07|\x1b\\)/);
		if (osc) {
			i += osc[0].length;
			continue;
		}
		const csi = rest.match(/^\x1b\[[0-9;]*[A-Za-z]/);
		if (csi) {
			i += csi[0].length;
			continue;
		}
		map.push(i);
		i++;
	}
	return map;
}

// ── footer wrapper ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, _theme, footerData) => {
			renderTui = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			// Thin session shim satisfying FooterComponent's reads, sourced from ctx.
			const shimSession = {
				state: { get model() { return ctx.model; }, get thinkingLevel() { return ctx.thinkingLevel; } },
				sessionManager: ctx.sessionManager,
				getContextUsage: () => ctx.getContextUsage(),
				modelRuntime: { isUsingOAuth: (_provider: string) => false },
			};
			const builtIn = new FooterComponent(shimSession as never, footerData);

			return {
				dispose: unsub,
				invalidate() {
					builtIn.invalidate?.();
				},
				render(width: number): string[] {
					const lines = builtIn.render(width);
					try {
						const seg = renderBaconSegment(ctx.ui.theme);
						if (seg && lines[1]) lines[1] = injectBeforeCtx(lines[1], seg, width);
					} catch {
						/* never let footer rendering crash pi */
					}
					return lines;
				},
			};
		});

		reconcile(ctx);
	});

	// Follow project switches across turns.
	pi.on("context", (_event, ctx) => reconcile(ctx));

	pi.on("session_shutdown", () => {
		stopBacon();
		gitRoot = null;
		lastCwd = undefined;
		setStatus({ active: false, building: false, job: undefined, errors: undefined, warnings: undefined, failed: false });
	});
	process.on("exit", stopBacon);
}
