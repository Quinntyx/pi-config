import { createHash } from "node:crypto";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { AgentMessage, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUMMARY_PROVIDER = "antigravity";
const SUMMARY_MODEL_ID = "gemini-3.6-flash-high";

// Soft cap on how much surrounding context we forward to Gemini per source,
// to keep summary calls bounded even when a turn is very long.
const MAX_CONTEXT_CHARS = 6000;

const summaryCache = new Map<string, string>();
const inFlightSummaries = new Map<string, Promise<string>>();

function hashImage(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

function truncate(s: string, max = MAX_CONTEXT_CHARS): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/** All text in a message, ignoring image and other non-text blocks. */
function messageText(msg: AgentMessage): string {
	if (typeof msg.content === "string") return msg.content.trim();
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((b: any) => b.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("\n")
			.trim();
	}
	return "";
}

async function summarizeImage(
	data: string,
	mimeType: string,
	targetModelId: string,
	ctx: any,
	containingMessageText: string | null,
	precedingTurnText: string | null,
): Promise<string> {
	const hash = hashImage(data);
	if (summaryCache.has(hash)) {
		return summaryCache.get(hash)!;
	}
	if (inFlightSummaries.has(hash)) {
		return inFlightSummaries.get(hash)!;
	}

	// NOTE: the cache is keyed by image hash only (not by context). The context
	// event fires on every model call, so keying on context would re-summarize
	// the same historical image every turn. Instead, the summary is generated
	// once — with whatever context is present at first sighting — and reused.
	// For the common case (image appears, gets described, then referenced) this
	// captures the relevant context while avoiding repeated Gemini calls.
	const promise = (async () => {
		try {
			const model = ctx.modelRegistry?.find(SUMMARY_PROVIDER, SUMMARY_MODEL_ID);
			const provider = ctx.modelRegistry?.getProvider(SUMMARY_PROVIDER);
			if (!model || !provider) {
				return `[Automatic image summary unavailable: ${SUMMARY_PROVIDER}/${SUMMARY_MODEL_ID} is not registered]`;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				return `[Automatic image summary unavailable: ${auth.error}]`;
			}

			// Build a context block from the containing message + preceding turn.
			// When present, the prompt tells Gemini to weight the summary toward
			// details that matter for that context.
			const contextParts: string[] = [];
			if (precedingTurnText) {
				contextParts.push(`Preceding turn:\n"""\n${truncate(precedingTurnText)}\n"""`);
			}
			if (containingMessageText) {
				contextParts.push(`Message containing this image:\n"""\n${truncate(containingMessageText)}\n"""`);
			}
			const hasContext = contextParts.length > 0;
			const contextBlock = hasContext
				? `\n\n=== Conversation context ===\n${contextParts.join("\n\n")}\n=== End context ===\n`
				: "";

			const instruction = hasContext
				? "Analyze this image and write a concise, high-density factual description for a non-vision coding agent. Conversation context is provided below — use it to decide what matters: emphasize the labels, values, regions, axes, trends, or UI elements that are relevant to that context, while still briefly capturing the image's overall structure and purpose. Do not omit context-relevant details even if they seem minor, but stay compact and avoid speculating beyond what is visible."
				: "Analyze this image carefully. Describe its main features, structure, layout, visible text, labels, numbers, data trends, plot axes, or UI state concisely so a non-vision model can understand it.";

			const userText = `${instruction}${contextBlock}`;

			const response = await provider
				.streamSimple(
					model,
					{
						systemPrompt:
							"You are an expert visual analyzer providing concise, high-density factual descriptions of images, diagrams, charts, screenshots, and plots for non-vision coding agents.",
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: userText },
									{ type: "image", mimeType: mimeType || "image/png", data },
								],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
						maxTokens: 4096,
						reasoning: "high",
						cacheRetention: "none",
						sessionId: uuidv7(),
					},
				)
				.result();

			const summaryText = response.content
				.filter((block: any): block is { type: "text"; text: string } => block.type === "text")
				.map((block: any) => block.text)
				.join("\n")
				.trim();

			if (!summaryText) {
				return "[Automatic image summary unavailable: empty model response]";
			}

			summaryCache.set(hash, summaryText);
			return summaryText;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return `[Automatic image summary failed: ${msg}]`;
		} finally {
			inFlightSummaries.delete(hash);
		}
	})();

	inFlightSummaries.set(hash, promise);
	return promise;
}

export default function imageFallback(pi: ExtensionAPI) {
	pi.on("context", async (event, ctx) => {
		const currentModel = ctx.model;
		if (!currentModel) return;

		// Vision models support image input natively. Pass through untouched.
		const supportsVision = Array.isArray(currentModel.input) && currentModel.input.includes("image");
		if (supportsVision) return;

		const messages: AgentMessage[] = event.messages;
		let modified = false;

		const transformedMessages: AgentMessage[] = await Promise.all(
			messages.map(async (msg, idx) => {
				if (typeof msg.content === "string" || !Array.isArray(msg.content)) {
					return msg;
				}

				const hasImages = msg.content.some((block: any) => block.type === "image");
				if (!hasImages) return msg;

				// Context for the summary: the text of this message (excluding the
				// image itself) and the immediately preceding turn, if any.
				const containingMessageText = messageText(msg) || null;
				const precedingMsg = idx > 0 ? messages[idx - 1] : undefined;
				const precedingTurnText = precedingMsg ? messageText(precedingMsg) || null : null;

				modified = true;
				const newContent = await Promise.all(
					msg.content.map(async (block: any) => {
						if (block.type !== "image" || !block.data) {
							return block;
						}

						const summary = await summarizeImage(
							block.data,
							block.mimeType || "image/png",
							currentModel.id,
							ctx,
							containingMessageText,
							precedingTurnText,
						);

						return {
							type: "text" as const,
							text: `[Image summary generated by ${SUMMARY_PROVIDER}/${SUMMARY_MODEL_ID} because ${currentModel.id} does not support image input]\n\n${summary}\n\n[/Image summary]`,
						};
					}),
				);

				return {
					...msg,
					content: newContent,
				} as AgentMessage;
			}),
		);

		if (modified) {
			return { messages: transformedMessages };
		}
	});
}
