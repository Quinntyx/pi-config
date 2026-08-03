import type { AgentMessage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";

// Primary model: free DeepSeek V4 Flash on the opencode provider.
const FREE_PROVIDER = "opencode";
const FREE_MODEL_ID = "deepseek-v4-flash-free";

// Failover model: paid DeepSeek V4 Flash via OpenRouter (routed to deepinfra).
const PAID_PROVIDER = "openrouter";
const PAID_MODEL_ID = "deepseek/deepseek-v4-flash-0731";

// Quota/billing exhaustion signals. Mirrors pi's non-retryable limit-error
// classification (pi-ai utils/retry.ts): OpenCode's FreeUsageLimitError /
// GoUsageLimitError, plus common gateway wording such as "quota exceeded",
// OpenAI's "insufficient_quota", and generic "quota"/"usage limit" text.
const QUOTA_PATTERN =
	/FreeUsageLimitError|GoUsageLimitError|insufficient_quota|quota|usage limit|out of budget|billing|available balance/i;

function isFreeModel(provider: string | undefined, model: string | undefined): boolean {
	return provider === FREE_PROVIDER && model === FREE_MODEL_ID;
}

/** Text content of a message (ignoring images and other non-text blocks). */
function messageText(msg: AgentMessage | undefined): string {
	if (!msg) return "";
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

export default function quotaFailover(pi: ExtensionAPI) {
	// One-shot guard: re-issue a failed turn at most once per failover cycle so
	// a failing paid model can't loop us back into re-issue.
	let reissued = false;

	// If the user manually switches back to the free model (e.g. after the
	// quota resets), allow a fresh failover + re-issue cycle.
	pi.on("model_select", (event) => {
		const model = event.model;
		if (model && isFreeModel(model.provider, model.id)) {
			reissued = false;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const messages: AgentMessage[] = event.messages ?? [];
		let failing: AgentMessage | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				failing = msg;
				break;
			}
		}
		if (!failing) return;

		const failed = failing as any;
		if (failed.stopReason !== "error") return;
		const errorMessage: string = failed.errorMessage ?? "";
		if (!QUOTA_PATTERN.test(errorMessage)) return;

		// Only fail over when the failing call ran on the free model.
		const failingProvider: string | undefined = failed.provider ?? ctx.model?.provider;
		const failingModel: string | undefined = failed.model ?? ctx.model?.id;
		if (!isFreeModel(failingProvider, failingModel)) return;

		// 1) Point the session at the paid model. Idempotent: only switch while
		//    the free model is still the active one.
		const current = ctx.model;
		if (current && isFreeModel(current.provider, current.id)) {
			const fallback = ctx.modelRegistry?.find(PAID_PROVIDER, PAID_MODEL_ID);
			if (!fallback) {
				ctx.ui?.notify?.(`Quota failover unavailable: ${PAID_PROVIDER}/${PAID_MODEL_ID} is not registered`, "error");
				return;
			}
			const switched = await pi.setModel(fallback);
			if (!switched) {
				ctx.ui?.notify?.(`Quota failover failed: no API key for ${PAID_PROVIDER}/${PAID_MODEL_ID}`, "error");
				return;
			}
			ctx.ui?.notify?.(
				`${FREE_PROVIDER}/${FREE_MODEL_ID} quota exhausted — failed over to ${PAID_PROVIDER}/${PAID_MODEL_ID}`,
				"info",
			);
		}

		// 2) Make sure the failed turn completes on the paid model.
		//    - Retryable-looking errors (e.g. plain "rate limit" text): pi's own
		//      auto-retry re-issues the call during its backoff; the continuation
		//      reads the current session model, which we just switched. Done.
		//    - Non-retryable quota errors (FreeUsageLimitError etc.): pi fails
		//      the turn fast, so re-issue the user's last message ourselves. The
		//      run loop drains messages queued by agent_end handlers, so the
		//      follow-up continuation runs on the paid model.
		if (isRetryableAssistantError(failed as any)) return;
		if (reissued) return;
		reissued = true;

		const lastUser = [...messages].reverse().find((m) => m.role === "user");
		const promptText = messageText(lastUser);
		if (!promptText) return;

		try {
			await pi.sendUserMessage(
				`[Auto-failover: ${FREE_PROVIDER}/${FREE_MODEL_ID} hit its quota — re-running your last message on ${PAID_PROVIDER}/${PAID_MODEL_ID}]\n\n${promptText}`,
				{ deliverAs: "followUp" },
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui?.notify?.(`Quota failover re-issue failed: ${msg}`, "error");
		}
	});
}
