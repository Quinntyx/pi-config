/**
 * Auto-continue after auto-compaction
 *
 * Pi's built-in compaction has two automatic triggers:
 *   - "overflow"  : context overflow -> auto-retries (willRetry: true), no help needed
 *   - "threshold" : context getting large -> compacts, then goes IDLE waiting for input
 *
 * The threshold case leaves you at an empty prompt. This extension sends a single
 * "continue" user turn so the model resumes automatically (OpenCode-style, but with
 * a short nudge instead of duplicating the last prompt).
 *
 * Manual `/compact` is deliberately left alone — you chose to compact, so you expect
 * to land at an idle prompt. Overflow recovery is also left alone since it already resumes.
 *
 * Timing note: `session_compact` fires while the agent run is still active (between
 * agent_end and agent_settled), so a bare sendUserMessage throws "Agent is already
 * processing". We branch like send-user-message.ts: queue as followUp when busy, which
 * dispatches automatically once the agent settles idle right after compaction completes.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTINUE_PROMPT = "continue";

export default function (pi: ExtensionAPI) {
  pi.on("session_compact", (_event, ctx) => {
    const event = _event as {
      reason: "manual" | "threshold" | "overflow";
      willRetry: boolean;
    };

    // Only nudge on auto-compaction that left the agent idle.
    // - Skip "manual" (/compact): user expects to land at an idle prompt.
    // - Skip willRetry===true (overflow recovery): it already resumes by itself.
    if (event.reason === "manual" || event.willRetry) return;

    if (ctx.isIdle()) {
      pi.sendUserMessage(CONTINUE_PROMPT);
    } else {
      // Agent is still finishing the compaction run — queue until it settles idle.
      pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
    }
    ctx.ui.notify("Auto-continue: resumed after compaction", "info");
  });
}
