/**
 * tools.ts — the three Pilot tools.
 *
 *   tmux_read_pane  — non-blocking observation (capture the Primary pane).
 *   tmux_send_chars — non-blocking keystrokes; CANNOT start a turn (the
 *                     Primary's turn gate blocks UI-submitted Enter unless the
 *                     Pilot first sent start_turn_ok via tmux_start_turn).
 *   tmux_start_turn — blocking; sends start_turn_ok (lifting the gate), then
 *                     dispatches the submitting keys and correlates the
 *                     resulting agent_start / agent_settled events by seq.
 *
 * All tmux I/O goes through ctx.exec("tmux", [...]). See ARCHITECTURE.md §4, §9.
 */

import { Type } from "@earendil-works/pi-ai";
import { keyText } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import {
  AutopilotClient,
  WaitForTimeoutError,
  ClientClosedError,
  type BroadcastEvent,
} from "./ipc";

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

/** tmux scrollback lines to capture from the Primary pane. */
const CAPTURE_LINES = 200;

/** Capture a tmux pane's buffer as plain text (last CAPTURE_LINES lines). */
async function capturePane(pi: ExtensionAPI, pane: string): Promise<string> {
  const res = await pi.exec("tmux", [
    "capture-pane",
    "-p", // print to stdout
    "-S", `-${CAPTURE_LINES}`, // start N lines back in history
    "-E", "-", // end at bottom of history
    "-t", pane,
  ]);
  if (res.code !== 0) {
    throw new Error(`tmux capture-pane failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

/** Send keys to a tmux pane. Each entry in `keys` is one tmux key argument. */
async function sendKeys(pi: ExtensionAPI, pane: string, keys: string[]): Promise<void> {
  if (!pane) throw new Error("No tmux pane target provided.");
  const res = await pi.exec("tmux", ["send-keys", "-t", pane, ...keys]);
  if (res.code !== 0) {
    throw new Error(`tmux send-keys failed: ${res.stderr || res.stdout}`);
  }
}

/** Build a text tool result. */
function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

/** Build an error tool result (isError-style: content carries the diagnostic). */
function errorResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

// ---------------------------------------------------------------------------
// Tool 1: tmux_read_pane
// ---------------------------------------------------------------------------

export function makeTmuxReadPaneTool(mainPane: string, pi: ExtensionAPI): ToolDefinition {
  return {
    name: "tmux_read_pane",
    label: "Read main pane",
    description:
      "Capture the current text content of the main Pi pane (the agent you are steering). " +
      "Non-blocking. Use this to observe what the main agent is showing before deciding your next step.",
    promptSnippet: "tmux_read_pane — capture the main Pi pane's current screen content",
    parameters: Type.Object({}),
    renderCall(_args, theme, context) {
      const text = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const hint = context.expanded
        ? ""
        : theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
      text.setText(
        `${theme.fg("toolTitle", theme.bold("Read pane"))} ${theme.fg("accent", mainPane)}${hint}`,
      );
      return text;
    },
    renderResult(result, options, theme, context) {
      const text = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const output = result.content
        .map((item) => item.type === "text" ? item.text : "")
        .filter(Boolean)
        .join("\n");
      text.setText(!options.expanded && !context.isError ? "" : theme.fg("toolOutput", output));
      return text;
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!mainPane) {
        throw new Error("No main pane configured (PI_AUTOPILOT_MAIN_PANE unset).");
      }
      try {
        const buffer = await capturePane(pi, mainPane);
        return textResult(buffer.replace(/\s+$/, "") || "(main pane is empty)");
      } catch (e) {
        throw new Error(
          `tmux_read_pane failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 2: tmux_send_chars (non-blocking, cannot start a turn)
// ---------------------------------------------------------------------------

export function makeTmuxSendCharsTool(mainPane: string, pi: ExtensionAPI): ToolDefinition {
  return {
    name: "tmux_send_chars",
    label: "Send keystrokes (no turn)",
    description:
      "Send keystrokes to the main Pi pane WITHOUT starting a turn. Each entry in `keys` is one tmux " +
      "key argument. Use this for non-submitting keys: clear the input line (C-u), cycle history " +
      "(Up/Down), change the thinking level (Shift-Tab), move the cursor, or type a draft. " +
      "DO NOT use this to submit a turn — the main pane blocks turns started by tmux_send_chars. " +
      "To submit a turn, use tmux_start_turn instead. " +
      "Returns instantly.",
    promptSnippet:
      "tmux_send_chars — send non-submitting keystrokes to the main pane (cannot start a turn)",
    promptGuidelines: [
      "Use tmux_send_chars only for keystrokes that do NOT submit a turn (C-u, Up/Down, Shift-Tab, cursor moves, typing a draft).",
      "To actually submit a turn, use tmux_start_turn — never tmux_send_chars with Enter.",
    ],
    parameters: Type.Object({
      keys: Type.Array(Type.String(), {
        description:
          'Keystrokes to send, in order. Each entry is one tmux key argument, e.g. ["C-u"], ["Shift-Tab"], ["Up"]. Do not use this to submit a turn — use tmux_start_turn to submit turns.',
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const keys = (params as { keys?: string[] }).keys;
      if (!Array.isArray(keys) || keys.length === 0) {
        throw new Error("tmux_send_chars requires a non-empty `keys` array.");
      }
      if (!mainPane) {
        throw new Error("No main pane configured (PI_AUTOPILOT_MAIN_PANE unset).");
      }
      try {
        await sendKeys(pi, mainPane, keys);
        const sent = keys.map((k) => (k === "Enter" ? "⏎" : k)).join(" ");
        return textResult(`Sent to main pane: ${sent}`);
      } catch (e) {
        throw new Error(
          `tmux_send_chars failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 3: tmux_start_turn (blocking, always starts a turn)
// ---------------------------------------------------------------------------

const PHASE1_TIMEOUT_MS = 30_000; // wait for agent_start
const PHASE2_TIMEOUT_MS = 10 * 60_000; // wait for agent_settled

export function makeTmuxStartTurnTool(
  mainPane: string,
  client: AutopilotClient,
  pi: ExtensionAPI,
): ToolDefinition {
  return {
    name: "tmux_start_turn",
    label: "Start a main-pane turn",
    description:
      "Submit a turn in the main Pi pane and block until it finishes. Sends a start_turn_ok signal " +
      "(lifting the main pane's turn gate), then dispatches the given keystrokes (typically [\"Enter\"]) " +
      "and waits for the main agent's agent_start then agent_settled events. Returns the main pane's " +
      "new content once the turn settles. If the keys do not actually start a turn (30s), returns an " +
      "error with the current pane content so you can self-correct. This is the ONLY way to start a " +
      "main-pane turn.",
    promptSnippet:
      "tmux_start_turn — submit a turn in the main pane and block until it settles (returns new pane content)",
    promptGuidelines: [
      "Use tmux_start_turn to submit a turn in the main pane; it blocks until the turn finishes and returns the new pane content.",
      "To type a message before submitting, use tmux_send_chars to type the draft, then tmux_start_turn with [\"Enter\"].",
    ],
    parameters: Type.Object({
      keys: Type.Array(Type.String(), {
        description:
          'Keystrokes that submit the turn, in order. Usually ["Enter"]. If you typed a draft with tmux_send_chars first, just ["Enter"] submits it.',
      }),
    }),
    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const keys = Array.isArray(args.keys) ? args.keys.join(" ") : "";
      const keysLabel = keys ? ` ${theme.fg("accent", keys)}` : "";
      const hint = context.expanded
        ? ""
        : theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
      text.setText(
        `${theme.fg("toolTitle", theme.bold("Start turn in pane"))} ${theme.fg("accent", mainPane)}${keysLabel}${hint}`,
      );
      return text;
    },
    renderResult(result, options, theme, context) {
      const text = context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
      const output = result.content
        .map((item) => item.type === "text" ? item.text : "")
        .filter(Boolean)
        .join("\n");
      text.setText(!options.expanded && !context.isError ? "" : theme.fg("toolOutput", output));
      return text;
    },
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const keys = (params as { keys?: string[] }).keys;
      if (!Array.isArray(keys) || keys.length === 0) {
        throw new Error("tmux_start_turn requires a non-empty `keys` array.");
      }
      if (!mainPane) {
        throw new Error("No main pane configured (PI_AUTOPILOT_MAIN_PANE unset).");
      }

      // 1. Lift the Primary's turn gate for the next UI-submitted turn.
      client.send({ type: "start_turn_ok", ts: Date.now() });

      // 2. Capture the seq baseline BEFORE dispatching the submitting keys.
      const beforeSeq = client.lastObservedSeq;

      // 3. Dispatch the submitting keys.
      try {
        await sendKeys(pi, mainPane, keys);
      } catch (e) {
        return errorResult(
          `tmux_start_turn: send-keys failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // 4. Phase 1: wait for agent_start with seq > beforeSeq (30s).
      let startSeq: number;
      try {
        const startEv: BroadcastEvent = await client.waitForEvent(
          "agent_start",
          (e) => e.seq > beforeSeq,
          { timeoutMs: PHASE1_TIMEOUT_MS, signal: signal ?? undefined },
        );
        startSeq = startEv.seq;
      } catch (e) {
        if (e instanceof WaitForTimeoutError) {
          // The keys did not start a turn. Return an error + current pane
          // content so the model can see what happened and self-correct.
          let pane = "";
          try { pane = (await capturePane(pi, mainPane)).replace(/\s+$/, ""); } catch { /* best-effort */ }
          return errorResult(
            `tmux_start_turn: the keys did not start a turn within 30s (no agent_start with seq > ${beforeSeq}). ` +
              `The keystrokes may not have submitted. Current main pane content:\n\n${pane}`,
          );
        }
        if (e instanceof ClientClosedError) {
          return errorResult(`tmux_start_turn: IPC connection closed while waiting for agent_start: ${e.message}`);
        }
        return errorResult(`tmux_start_turn: error waiting for agent_start: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 5. Phase 2: wait for agent_settled with seq > startSeq (10min).
      try {
        await client.waitForEvent(
          "agent_settled",
          (e) => e.seq > startSeq,
          { timeoutMs: PHASE2_TIMEOUT_MS, signal: signal ?? undefined },
        );
      } catch (e) {
        if (e instanceof WaitForTimeoutError) {
          let pane = "";
          try { pane = (await capturePane(pi, mainPane)).replace(/\s+$/, ""); } catch { /* best-effort */ }
          return errorResult(
            `tmux_start_turn: the turn started (agent_start seq=${startSeq}) but did not settle within 10min. ` +
              `Current main pane content:\n\n${pane}`,
          );
        }
        if (e instanceof ClientClosedError) {
          return errorResult(`tmux_start_turn: IPC connection closed while waiting for agent_settled: ${e.message}`);
        }
        return errorResult(`tmux_start_turn: error waiting for agent_settled: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 6. Success: return the finished pane content.
      try {
        const buffer = await capturePane(pi, mainPane);
        return textResult(buffer.replace(/\s+$/, "") || "(main pane is empty)");
      } catch (e) {
        return errorResult(
          `tmux_start_turn: turn settled but failed to capture pane: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pilot system prompt
// ---------------------------------------------------------------------------

/** Build the Pilot's base system prompt. `goal` is optional. */
export function buildPilotSystemPrompt(goal: string): string {
  return `You are the Autopilot — a higher-reasoning steering agent running in a sidecar tmux pane.
You observe a SECOND Pi instance (the "main agent") running in another tmux pane and drive it
toward a goal by sending keystrokes to it. You do NOT touch the filesystem or run commands
yourself; you only steer the main agent.

YOUR TOOLS — exactly three:
  - tmux_read_pane:  Capture the main pane's current screen content. Non-blocking. Use this to
                     observe what the main agent is showing before deciding your next step.
  - tmux_send_chars: Send NON-SUBMITTING keystrokes to the main pane (C-u to clear the input
                     line, Up/Down for history, Shift-Tab to change thinking level, cursor moves,
                     or type a draft message). Returns instantly. CANNOT start a turn — the main
                     pane blocks turns started by tmux_send_chars. To submit a turn, use tmux_start_turn.
  - tmux_start_turn: Submit a turn in the main pane and BLOCK until it finishes. This is the ONLY
                     way to start a main-pane turn. It lifts the turn gate, sends the submitting
                     keys (usually ["Enter"]), waits for the turn to start and settle, then returns
                     the main pane's new content.

WORKFLOW:
  1. tmux_read_pane to see the main agent's current state.
  2. If you need to edit the input box first (clear it, type a draft, change thinking level), use
     tmux_send_chars with the appropriate keys.
  3. When ready to make the main agent do something, use tmux_start_turn with ["Enter"] (or type
     the message with tmux_send_chars first, then tmux_start_turn ["Enter"]).
  4. tmux_start_turn returns the main pane's new content after the turn settles — read it and
     decide the next step. You do not need a separate tmux_read_pane after a successful turn.

KEYBINDINGS (tmux key names for tmux_send_chars):
  - ["C-c"]          Interrupt the main agent's current run (hard stop).
  - ["Escape"]       Cancel/dismiss the current input or prompt.
  - ["C-u"]          Clear the main pane's current input line (no submission).
  - ["Up"] / ["Down"]  Navigate the main pane's input history (no submission).
  - ["Shift-Tab"]    Change the main agent's thinking level (no submission).
  - ["/compact", ...]  Type a slash command as a draft (then submit with tmux_start_turn).

REASONING FREEDOM:
You may think and reason at length before acting. Use that freedom to plan the single most useful
next step given the main pane buffer. But once you have decided, act decisively.

The human can type into THIS pane to steer you. Their messages are part of your normal conversation.
Follow their guidance.
${goal ? `\nGoal:\n${goal}` : ""}`;
}