import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

const PROVIDER = "antigravity";
const MODEL_ID = "gemini-3.6-flash-high";

export default function geminiCompaction(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
    const provider = ctx.modelRegistry.getProvider(PROVIDER);

    if (!model || !provider) {
      ctx.ui.notify(`Compaction requires ${PROVIDER}/${MODEL_ID}, but it is unavailable`, "error");
      return { cancel: true };
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(`Gemini compaction authentication failed: ${auth.error}`, "error");
      return { cancel: true };
    }

    const { preparation, customInstructions, reason, signal } = event;
    const {
      messagesToSummarize,
      turnPrefixMessages,
      previousSummary,
      firstKeptEntryId,
      tokensBefore,
    } = preparation;

    // Flatten the conversation before giving it to Gemini. Tool calls and their
    // results become inert text in persisted source order, so the summarization
    // request contains one user message, no tools, and cannot violate Gemini's
    // strict function-call/function-response ordering requirements.
    const conversation = serializeConversation(
      convertToLlm([...messagesToSummarize, ...turnPrefixMessages]),
    );
    const previous = previousSummary
      ? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>`
      : "";
    const extra = customInstructions
      ? `\n\nAdditional instructions:\n${customInstructions}`
      : "";

    ctx.ui.notify(
      `Compacting ${tokensBefore.toLocaleString()} tokens with Gemini 3.6 Flash High`,
      "info",
    );

    try {
      const response = await provider
        .streamSimple(
          model,
          {
            systemPrompt:
              "You are a precise coding-session summarizer. Preserve actionable state and never continue the conversation or invoke tools.",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `Create a self-contained continuation summary of the coding session below. Include goals, constraints, decisions and rationale, important findings, exact files changed, commands/tests and results, unresolved risks, and concrete next steps. Preserve identifiers, paths, model names, configuration values, and error messages that remain relevant. Distinguish completed work from pending work. Be comprehensive but avoid repetition.${previous}${extra}\n\n<conversation>\n${conversation}\n</conversation>`,
                  },
                ],
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            maxTokens: 16_384,
            reasoning: "high",
            signal,
            cacheRetention: "none",
            sessionId: uuidv7(),
          },
        )
        .result();

      const summary = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      if (!summary) {
        if (!signal.aborted) ctx.ui.notify("Gemini returned an empty compaction summary", "error");
        return { cancel: true };
      }

      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
          usage: response.usage,
          details: { provider: PROVIDER, model: MODEL_ID, reason },
        },
      };
    } catch (error) {
      if (!signal.aborted) {
        ctx.ui.notify(
          `Gemini compaction failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      // Never silently fall back to the active conversation model: compaction
      // is pinned to Gemini by design.
      return { cancel: true };
    }
  });
}
