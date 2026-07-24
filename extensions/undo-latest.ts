import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * `/undo` is `/fork` with the most recent user message preselected.
 * It creates a new session before that message and restores the message text
 * to the editor, matching the normal `/fork` behavior after pressing Enter.
 */
export default function undoLatest(pi: ExtensionAPI) {
  pi.registerCommand("undo", {
    description: "Fork before the most recent user message",
    handler: async (_args, ctx) => {
      // Extension contexts expose SessionManager, whereas Pi's internal
      // /fork picker uses an AgentSession-only convenience method. Recreate
      // that small query from the public session entries.
      const entries = ctx.sessionManager.getEntries();
      let latest: { entryId: string; text: string } | undefined;

      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry.type !== "message" || entry.message.role !== "user") continue;

        const content = entry.message.content;
        const text = typeof content === "string"
          ? content
          : content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("");

        if (text) {
          latest = { entryId: entry.id, text };
          break;
        }
      }

      if (!latest) {
        ctx.ui.notify("No messages to undo", "warning");
        return;
      }

      // Capture only plain data: the original command context is stale after
      // session replacement, so editor updates must use the fresh context.
      const restoredText = latest.text;
      const result = await ctx.fork(latest.entryId, {
        withSession: async (freshCtx) => {
          freshCtx.ui.setEditorText(restoredText);
          freshCtx.ui.notify("Forked before the most recent message", "info");
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("Undo cancelled", "warning");
      }
    },
  });
}
