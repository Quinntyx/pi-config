/**
 * Auto-continue after interrupted auto-compaction.
 *
 * A threshold compaction can happen in two places: after an agent run, or during
 * preflight for a real user prompt. `session_compact` fires before that preflight
 * prompt is submitted. Sending "continue" from `session_compact` races the real
 * prompt and can turn it into steering input, effectively swallowing it.
 *
 * Arm a continuation at compaction time, but dispatch it only at `agent_settled`.
 * Any user message delivered in between cancels the synthetic continuation. This
 * preserves automatic resumption for interrupted turns without racing typed input.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTINUE_PROMPT = "continue";

export default function (pi: ExtensionAPI) {
  let lastStopReason: string | undefined;
  let continuationPending = false;

  pi.on("turn_end", (event) => {
    const message = (event as { message?: { role?: string; stopReason?: string } }).message;
    if (message?.role === "assistant" && typeof message.stopReason === "string") {
      lastStopReason = message.stopReason;
    }
  });

  // A real user message always wins over an armed synthetic continuation. This
  // catches both prompts submitted while compaction is running and prompts whose
  // preflight check itself triggered the compaction.
  pi.on("message_end", (event) => {
    if (event.message.role === "user") {
      continuationPending = false;
    }
  });

  pi.on("session_compact", (event, ctx) => {
    continuationPending = false;

    // Manual compaction intentionally lands at an idle prompt. Overflow recovery
    // already retries by itself when willRetry is true.
    if (event.reason === "manual" || event.willRetry) {
      lastStopReason = undefined;
      return;
    }

    const stopReason = lastStopReason;
    lastStopReason = undefined;

    // Do not manufacture another turn after a response that completed normally.
    if (stopReason === "stop") {
      ctx.ui.notify("Auto-continue: skipping nudge (turn completed naturally)", "info");
      return;
    }

    continuationPending = true;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!continuationPending) return;

    continuationPending = false;
    pi.sendUserMessage(CONTINUE_PROMPT);
    ctx.ui.notify("Auto-continue: resumed after compaction", "info");
  });
}
