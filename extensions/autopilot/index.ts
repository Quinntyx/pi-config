/**
 * index.ts — autopilot extension entrypoint.
 *
 * Two modes, one extension directory:
 *
 * 1. PRIMARY mode (default). Registers:
 *      - /autopilot [goal]  : spawn the Pilot sidecar in a tmux split, start
 *        the IPC server, arm the turn gate, set the footer status.
 *      - agent_start / agent_settled hooks : broadcast sequence-numbered
 *        events to the Pilot client.
 *      - input hook : the turn gate. Blocks UI-submitted (source "interactive")
 *        turns unless the Pilot has sent a one-shot start_turn_ok token.
 *        Programmatic turns (source "extension" / "rpc") are never blocked.
 *      - session_shutdown : close the server, clear the socket, clear status.
 *
 * 2. PILOT mode (PI_AUTOPILOT=1). Registers:
 *      - the three tools (tmux_read_pane, tmux_send_chars, tmux_start_turn),
 *        enforced as the entire tool surface via setActiveTools.
 *      - before_agent_start : inject the live main-pane buffer into the system
 *        prompt and re-assert the restricted tool surface.
 *      - session_shutdown : close the IPC client, clear status.
 *
 * See ARCHITECTURE.md.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { AutopilotClient, AutopilotServer } from "./ipc";
import {
  makeTmuxReadPaneTool,
  makeTmuxSendCharsTool,
  makeTmuxStartTurnTool,
  buildPilotSystemPrompt,
} from "./tools";
import { autopilotOn, autopilotPilot, autopilotOff } from "./ui";

// ---------------------------------------------------------------------------
// Mode detection + configuration
// ---------------------------------------------------------------------------

const PILOT = process.env.PI_AUTOPILOT === "1";
const MAIN_PANE = process.env.PI_AUTOPILOT_MAIN_PANE ?? "";
const SOCK = process.env.PI_AUTOPILOT_SOCK ?? "";
const GOAL = process.env.PI_AUTOPILOT_GOAL ?? "";

// ---------------------------------------------------------------------------
// tmux helpers (shared)
// ---------------------------------------------------------------------------

/** Resolve the current pane id (the pane this Pi is running in). */
async function currentPaneId(pi: ExtensionAPI): Promise<string | null> {
  const res = await pi.exec("tmux", ["display-message", "-p", "-F", "#{pane_id}"]);
  if (res.code !== 0) return null;
  return res.stdout.trim() || null;
}

/** Capture a tmux pane's buffer as plain text. */
async function capturePane(pi: ExtensionAPI, pane: string): Promise<string> {
  const res = await pi.exec("tmux", [
    "capture-pane", "-p", "-S", "-200", "-E", "-", "-t", pane,
  ]);
  if (res.code !== 0) throw new Error(`tmux capture-pane failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

// ---------------------------------------------------------------------------
// Model picker helpers (ported from legacy autopilot.ts)
// ---------------------------------------------------------------------------

function readEnabledModels(): string[] {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const { getAgentDir } = require("@earendil-works/pi-coding-agent") as {
      getAgentDir: () => string;
    };
    const path = join(getAgentDir(), "settings.json");
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { enabledModels?: unknown };
    return Array.isArray(parsed.enabledModels)
      ? parsed.enabledModels.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

function findModelByReference<
  T extends { provider: string; id: string },
>(reference: string, models: T[]): T | undefined {
  const ref = reference.trim();
  if (!ref) return undefined;
  const norm = ref.toLowerCase();
  const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === norm);
  if (canonical.length === 1) return canonical[0];
  const slashIdx = ref.indexOf("/");
  if (slashIdx !== -1) {
    const provider = ref.substring(0, slashIdx).trim().toLowerCase();
    const modelId = ref.substring(slashIdx + 1).trim().toLowerCase();
    if (provider && modelId) {
      const pm = models.filter(
        (m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
      );
      if (pm.length === 1) return pm[0];
    }
  }
  const idMatches = models.filter((m) => m.id.toLowerCase() === norm);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function modelLabels(ctx: ExtensionContext): string[] {
  const all = ctx.modelRegistry.getAvailable();
  const enabled = readEnabledModels();
  if (enabled.length === 0) {
    return all.map((m) => `${m.provider}/${m.id}`);
  }
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const pattern of enabled) {
    const m = findModelByReference(pattern, all);
    if (!m) continue;
    const label = `${m.provider}/${m.id}`;
    if (seen.has(label)) continue;
    seen.add(label);
    resolved.push(label);
  }
  return resolved.length > 0 ? resolved : all.map((m) => `${m.provider}/${m.id}`);
}

// ---------------------------------------------------------------------------
// PRIMARY mode
// ---------------------------------------------------------------------------

/** One-shot, short-TTL turn-allowance token for the input gate. */
class TurnToken {
  private armed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private static readonly TTL_MS = 5_000;

  arm(): void {
    this.disarm();
    this.armed = true;
    this.timer = setTimeout(() => { this.armed = false; this.timer = null; }, TurnToken.TTL_MS);
  }

  /** Consume the token. Returns true if a token was armed (and clears it). */
  consume(): boolean {
    if (this.armed) {
      this.disarm();
      return true;
    }
    return false;
  }

  disarm(): void {
    this.armed = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

function registerPrimary(pi: ExtensionAPI): void {
  let server: AutopilotServer | null = null;
  let sockPath = "";
  const turnToken = new TurnToken();
  // Whether autopilot is currently active (sidecar spawned, gate armed).
  // The input handler is a no-op unless this is true, so direct TUI input is
  // never blocked when /autopilot has not been invoked.
  let autopilotActive = false;

  // --- /autopilot [goal] : spawn the Pilot sidecar + start the IPC server ---
  pi.registerCommand("autopilot", {
    description: "Spawn a sidecar autopilot Pi in a vertical tmux split that drives this pane",
    handler: async (args, ctx) => {
      if (!process.env.TMUX) {
        ctx.ui.notify("Autopilot requires running inside tmux. Start pi under `tmux` first.", "error");
        return;
      }
      const pane = await currentPaneId(pi);
      if (!pane) {
        ctx.ui.notify("Autopilot: could not resolve current tmux pane id.", "error");
        return;
      }

      // Goal: explicit arg, else prompt.
      let goal = args.trim();
      if (!goal) {
        const input = await ctx.ui.input(
          "Autopilot goal",
          "What should the autopilot steer the main agent toward?",
        );
        if (!input) return;
        goal = input.trim();
      }

      // Model: let the user pick from the enabled cycle (or all models).
      const labels = modelLabels(ctx);
      if (labels.length === 0) {
        ctx.ui.notify("Autopilot: no models available for the sidecar.", "error");
        return;
      }
      const active = ctx.model;
      const activeLabel = active ? `active (${active.provider}/${active.id})` : null;
      const choices = activeLabel ? [activeLabel, ...labels] : labels;
      const choice = await ctx.ui.select("Sidecar model", choices);
      if (!choice) return;
      let modelRef: string;
      if (activeLabel && choice === activeLabel) {
        modelRef = `${active!.provider}/${active!.id}`;
      } else {
        const idx = activeLabel ? choices.indexOf(choice) - 1 : choices.indexOf(choice);
        modelRef = labels[idx] ?? choice;
      }

      // Start the IPC server BEFORE spawning the sidecar so it is ready to
      // accept the Pilot's connection.
      sockPath = `/tmp/pi-autopilot-${pane}.sock`;
      if (!server) server = new AutopilotServer();
      server.start(sockPath);
      // Arm the turn gate: a start_turn_ok from the Pilot lifts it for one turn.
      server.onStartTurnOk(() => turnToken.arm());
      // Mark autopilot active so the input gate begins enforcing turns.
      autopilotActive = true;

      // Spawn the sidecar: vertical split on the right, ~38% width.
      const sidecarArgs = [
        "split-window",
        "-h",
        "-l", "38%",
        "-c", ctx.cwd,
        "-e", `PI_AUTOPILOT=1`,
        "-e", `PI_AUTOPILOT_MAIN_PANE=${pane}`,
        "-e", `PI_AUTOPILOT_SOCK=${sockPath}`,
      ];
      if (goal) sidecarArgs.push("-e", `PI_AUTOPILOT_GOAL=${goal}`);

      const shellCmd = ["pi", "--model", modelRef];
      if (goal) shellCmd.push(JSON.stringify(goal));
      // Keepalive: on exit, drop into an interactive shell so the pane stays
      // open and any error remains visible for debugging.
      sidecarArgs.push(`${shellCmd.join(" ")}; exec bash`);

      const res = await pi.exec("tmux", sidecarArgs);
      if (res.code !== 0) {
        ctx.ui.notify(`Autopilot: tmux split-window failed: ${res.stderr || res.stdout}`, "error");
        // Roll back: the sidecar never came up, so disarm the gate.
        autopilotActive = false;
        turnToken.disarm();
        server?.close(sockPath);
        server = null;
        return;
      }

      autopilotOn(ctx);
      ctx.ui.notify(
        `Autopilot sidecar spawned (model ${modelRef}). Type in the right pane to steer it.`,
        "info",
      );
    },
  });

  // --- Broadcast agent_start / agent_settled to the Pilot ---
  pi.on("agent_start", () => {
    server?.broadcast("agent_start");
  });
  pi.on("agent_settled", () => {
    server?.broadcast("agent_settled");
  });

  // --- The turn gate: block UI-submitted turns unless the Pilot authorized ---
  pi.on("input", (event: InputEvent, ctx: ExtensionContext): InputEventResult => {
    // No-op unless autopilot is actually running. This is critical: the input
    // handler is registered at extension load, so without this guard it would
    // block ALL interactive input even when /autopilot was never invoked.
    if (!autopilotActive) {
      return { action: "continue" };
    }
    // Only gate interactive (UI-submitted) input. Programmatic turns
    // (source "extension" — e.g. compaction-resume continuations — or "rpc")
    // bypass the gate entirely.
    if (event.source !== "interactive") {
      return { action: "continue" };
    }
    // Never let an authorized Enter become a queued steering message while the
    // Primary is already running. Without this guard, Pilot retries can pile up
    // duplicate steering messages that execute after the current turn ends.
    if (!ctx.isIdle()) {
      turnToken.disarm();
      try {
        ctx.ui.notify(
          "autopilot: main pane is busy — refusing to queue another turn",
          "warning",
        );
      } catch { /* best-effort */ }
      return { action: "handled" };
    }
    // If the Pilot sent start_turn_ok, consume the one-shot token and allow.
    if (turnToken.consume()) {
      return { action: "continue" };
    }
    // Block: swallow the input so no turn starts, and surface an error both
    // in the pane (via notify) and to the Pilot (which will see it on its next
    // tmux_read_pane). The Pilot should use tmux_start_turn to start turns.
    try {
      ctx.ui.notify("autopilot: turn blocked — use tmux_start_turn to start a turn", "warning");
    } catch { /* best-effort */ }
    return { action: "handled" };
  });

  // --- Shutdown: close the server, clear the socket, clear status ---
  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    autopilotActive = false;
    turnToken.disarm();
    server?.close(sockPath);
    server = null;
    autopilotOff(ctx);
  });
}

// ---------------------------------------------------------------------------
// PILOT mode
// ---------------------------------------------------------------------------

function registerPilot(pi: ExtensionAPI): void {
  const client = new AutopilotClient();
  let connected = false;
  let statusSet = false;

  const basePrompt = buildPilotSystemPrompt(GOAL);

  // Register the three tools.
  pi.registerTool(makeTmuxReadPaneTool(MAIN_PANE, pi));
  pi.registerTool(makeTmuxSendCharsTool(MAIN_PANE, pi));
  pi.registerTool(makeTmuxStartTurnTool(MAIN_PANE, client, pi));

  // Connect to the Primary's IPC server. setActiveTools cannot run during
  // extension load, so we re-assert the restricted tool surface inside
  // before_agent_start (fires at the start of every turn).
  pi.on("before_agent_start", async (_event, ctx) => {
    // Restrict the Pilot's tool surface to exactly the three tmux tools.
    pi.setActiveTools(["tmux_read_pane", "tmux_send_chars", "tmux_start_turn"]);

    // Set the pilot footer status once (we have a ctx here).
    if (!statusSet) {
      statusSet = true;
      autopilotPilot(ctx);
    }

    // Connect lazily on the first turn if not yet connected.
    if (!connected && SOCK) {
      try {
        await client.connect(SOCK);
        connected = true;
      } catch {
        // Will retry on the next turn; tools will surface IPC errors.
      }
    }

    // Inject the live main-pane buffer into the system prompt.
    let buffer = "(main pane buffer unavailable)";
    if (MAIN_PANE) {
      try {
        const captured = await capturePane(pi, MAIN_PANE);
        buffer = captured.replace(/\s+$/, "") || "(main pane is empty)";
      } catch (e) {
        buffer = `(failed to capture main pane: ${e instanceof Error ? e.message : String(e)})`;
      }
    }
    return {
      systemPrompt: `${basePrompt}

=== MAIN PANE BUFFER ===
${buffer}
=== END MAIN PANE BUFFER ===
`,
    };
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    client.close();
    autopilotOff(ctx);
  });
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default function autopilot(pi: ExtensionAPI): void {
  if (PILOT) {
    registerPilot(pi);
  } else {
    registerPrimary(pi);
  }
}