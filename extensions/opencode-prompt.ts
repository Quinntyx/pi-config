import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatStatusRow(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	let leftText = left;
	let rightText = right;
	const minimumGap = 2;

	while (
		visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (
		visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(0, width - visibleWidth(leftText) - visibleWidth(rightText));
	return `${leftText}${" ".repeat(gapWidth)}${rightText}`;
}

function formatCwd(cwd: string): { parent: string; leaf: string } {
	const home = process.env.HOME;
	const display = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
	const slash = display.lastIndexOf("/");
	if (slash < 0) return { parent: "", leaf: display };
	return {
		parent: display.slice(0, slash + 1),
		leaf: display.slice(slash + 1) || "/",
	};
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		const value = tokens / 1_000_000;
		return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")}m`;
	}
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(Math.round(tokens));
}

function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!contextWindow || !usage) return "ctx ?";
	const percent = usage.percent === null ? "?" : `${Math.round(usage.percent)}%`;
	return `ctx ${formatTokens(usage.tokens)}/${formatTokens(contextWindow)} (${percent})`;
}

function readPtcTokensSaved(): number {
	const telemetry = (globalThis as Record<string, unknown>).__ptcTokensSaved as { tokensSaved?: number } | undefined;
	return telemetry?.tokensSaved ?? 0;
}

function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function formatNamePart(value: string): string {
	if (/^gpt$/i.test(value)) return "GPT";
	if (/^glm$/i.test(value)) return "GLM";
	if (/^qwen$/i.test(value)) return "Qwen";
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatModelName(id: string): string {
	return id
		.split(/[-_\s]+/g)
		.filter(Boolean)
		.map(formatNamePart)
		.join("-");
}

function formatProvider(provider: string | undefined): string {
	if (!provider) return "";
	if (provider === "openai" || provider === "openai-codex") return "OpenAI";
	if (provider === "zai") return "Z.ai (GLM Coding Plan)";
	return provider
		.split(/[-_]/g)
		.filter(Boolean)
		.map(formatNamePart)
		.join(" ");
}

function formatOwner(ownerPath: string): string {
	return ownerPath
		.split("/")
		.map((owner) => {
			if (owner.toLowerCase() === "zai-org") return "Z.ai";
			return owner
				.split(/[-_]/g)
				.filter(Boolean)
				.map(formatNamePart)
				.join(" ");
		})
		.join("/");
}

function formatModelIdentity(model: ExtensionContext["model"]): { name: string; attribution: string } {
	if (!model) return { name: "No-Model", attribution: "" };
	const path = model.id.split("/").filter(Boolean);
	let modelId = path.pop() ?? model.id;

	if (model.provider === "antigravity") {
		let family = "Gemini";
		if (/^gemini-/i.test(modelId)) {
			modelId = modelId.replace(/^gemini-/i, "");
			family = "Gemini";
		} else if (/^claude-/i.test(modelId)) {
			modelId = modelId.replace(/^claude-/i, "");
			family = "Claude";
		} else if (/^gpt-/i.test(modelId)) {
			modelId = modelId.replace(/^gpt-/i, "");
			family = "GPT";
		}
		return {
			name: formatModelName(modelId),
			attribution: `${family} (Antigravity)`,
		};
	}

	const provider = formatProvider(model.provider);
	return {
		name: formatModelName(modelId),
		attribution: path.length > 0 ? `${formatOwner(path.join("/"))} (${provider})` : provider,
	};
}

class EmptyFooter implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

const SENTINEL = "\x02";
const PROBE = "\x01";

// waverows spinner from vyfor/rattles — 16 frames, 90ms interval
const spinnerFrames = [
	"⠖⠉⠉⠑",
	"⡠⠖⠉⠉",
	"⣠⡠⠖⠉",
	"⣄⣠⡠⠖",
	"⠢⣄⣠⡠",
	"⠙⠢⣄⣠",
	"⠉⠙⠢⣄",
	"⠊⠉⠙⠢",
	"⠜⠊⠉⠙",
	"⡤⠜⠊⠉",
	"⣀⡤⠜⠊",
	"⢤⣀⡤⠜",
	"⠣⢤⣀⡤",
	"⠑⠣⢤⣀",
	"⠉⠑⠣⢤",
	"⠋⠉⠑⠣",
];

export default function (pi: ExtensionAPI) {
	let isWorking = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	let runStartedAt: number | undefined;
	let lastCompletion: string | undefined;
	let refreshBranch: (() => Promise<void>) | undefined;

	const stopSpinner = () => {
		if (spinnerTimer) clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	};

	pi.on("agent_start", () => {
		isWorking = true;
		runStartedAt ??= Date.now();
		lastCompletion = undefined;
		stopSpinner();
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
			activeTui?.requestRender();
		}, 90);
		activeTui?.requestRender();
	});

	pi.on("agent_settled", () => {
		isWorking = false;
		stopSpinner();
		if (runStartedAt !== undefined) {
			lastCompletion = `Completed in ${formatDuration(Date.now() - runStartedAt)}`;
			runStartedAt = undefined;
		}
		void refreshBranch?.();
		activeTui?.requestRender();
	});

	pi.on("model_select", () => activeTui?.requestRender());
	pi.on("thinking_level_select", () => activeTui?.requestRender());

	pi.on("session_shutdown", () => {
		stopSpinner();
		activeTui = undefined;
		refreshBranch = undefined;
		runStartedAt = undefined;
		lastCompletion = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setFooter(() => new EmptyFooter());

		let branch: string | undefined;
		refreshBranch = async () => {
			try {
				const result = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd });
				branch = result.stdout.trim() || undefined;
				activeTui?.requestRender();
			} catch {
				branch = undefined;
			}
		};
		void refreshBranch();

		class OpenCodePromptEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 0 });
				activeTui = tui;
			}

			render(width: number): string[] {
				if (width < 8) return super.render(width);

				const theme = ctx.ui.theme;
				const thinking = pi.getThinkingLevel();
				const accentRail = theme.getThinkingBorderColor(thinking);
				const rail = "┃";
				const bottomRail = "╹";
				// Layout: [rail 1] [padL 1] [editor content] [padR 1]
				const editorWidth = width - 3;

				// Probe theme.bg to extract raw ANSI prefix/suffix for persistent background.
				// The editor cursor uses \x1b[0m (full reset) which kills our background.
				// We replace \x1b[0m with \x1b[0m + bgPrefix to re-apply it after resets.
				const bgProbe = theme.bg("userMessageBg", PROBE);
				const bgParts = bgProbe.split(PROBE);
				const bgPrefix = bgParts[0] || "";
				const bgSuffix = bgParts[1] || "";

				// Convert the bg escape (48;...) into a fg escape (38;...) so we can
				// paint ▀ upper-half-block characters with the box background via
				// foreground, leaving the cell background transparent — only the top
				// half is filled, matching OpenCode's half-height bottom edge.
				const bgFgPrefix = bgPrefix.replace(/\x1b\[48/, "\x1b[38");
				const bgFgSuffix = "\x1b[39m";

				// Helper: build one line matching OpenCode's layout: the rail cell has
				// NO background (transparent — the narrow ┃ glyph leaves a gap that
				// shows the base color), and the opaque box bg starts at the padL
				// space. accentRail sets only the foreground (thinking-level color),
				// so the rail floats to the left of the content box with the gap
				// between them — exactly like OpenCode's border + boxed content.
				const buildLine = (content: string, contentWidth: number): string => {
					const visW = visibleWidth(content);
					const gap = Math.max(0, contentWidth - visW);
					const fixed = content.replace(/\x1b\[0m/g, `\x1b[0m${bgPrefix}`);
					return `${accentRail(rail)}${bgPrefix} ${fixed}${" ".repeat(gap)} ${bgSuffix}`;
				};

				// Half-height bottom strip matching OpenCode's bottom edge:
				// ╹ (heavy up, accent-colored) is the half-height rail char — the
				// vertical line lives in the upper half only, connecting to the ┃ rail
				// above while staying half-height. ▀ (upper half block, bg-colored via
				// foreground) fills the rest. No ANSI background escape is applied —
				// the top half is painted via foreground-colored half-blocks, leaving
				// the bottom half of every cell fully transparent.
				const buildBottomStrip = (fullWidth: number): string => {
					const fill = Math.max(0, fullWidth - 1);
					return `${accentRail(bottomRail)}${bgFgPrefix}${"▀".repeat(fill)}${bgFgSuffix}`;
				};

				// Use sentinel borderColor to detect top/bottom borders and separate
				// autocomplete lines from prompt lines.
				const originalBorderColor = this.borderColor;
				this.borderColor = () => SENTINEL;
				const rawLines = super.render(editorWidth);
				this.borderColor = originalBorderColor;

				if (rawLines.length < 3) return rawLines;

				// Find the bottom border (second SENTINEL)
				let bottomBorderIdx = -1;
				for (let i = rawLines.length - 1; i >= 1; i--) {
					if (rawLines[i] === SENTINEL) {
						bottomBorderIdx = i;
						break;
					}
				}
				if (bottomBorderIdx === -1) bottomBorderIdx = rawLines.length - 1;

				const promptLines = rawLines.slice(1, bottomBorderIdx);
				const autocompleteLines = rawLines.slice(bottomBorderIdx + 1);

				const result: string[] = [];

				// ── Slash-command autocomplete ABOVE the prompt ──
				for (const acLine of autocompleteLines) {
					const gap = Math.max(0, width - visibleWidth(acLine));
					result.push(acLine + " ".repeat(gap));
				}

				// ── Top vertical padding ──
				result.push(buildLine("", editorWidth));

				// ── Prompt input lines: opaque background + thin accent rail + padding ──
				for (const line of promptLines) {
					result.push(buildLine(line, editorWidth));
				}

				// ── Bottom vertical padding (between prompt and status) ──
				result.push(buildLine("", editorWidth));

				// ── Status row: same bg + rail + padding, spinner on the left ──
				const spinner = isWorking
					? `${theme.fg("accent", spinnerFrames[spinnerIndex])} `
					: "";
				const identity = formatModelIdentity(ctx.model);
				const model = theme.fg("muted", identity.name);
				const attribution = theme.fg("dim", identity.attribution);
				const reasoning = accentRail(theme.bold(thinking));

				const statusLeft = `${spinner}${model}${attribution ? ` · ${attribution}` : ""} · ${reasoning}`;
				const cwd = formatCwd(ctx.cwd);
				const completion = lastCompletion ? `${lastCompletion} · ` : "";
				const location = `${cwd.leaf}${branch ? `:${branch}` : ""}`;
				const tokensSaved = readPtcTokensSaved();
				const savedSegment = tokensSaved > 0
					? ` · ${theme.fg("success", `saved ${formatTokens(tokensSaved)}`)}`
					: "";
				const statusRight =
					theme.fg("dim", `${completion}${formatContext(ctx)}`) +
					savedSegment +
					theme.fg("dim", ` · `) +
					theme.fg("muted", location);

				const statusText = formatStatusRow(statusLeft, statusRight, editorWidth);
				result.push(buildLine(statusText, editorWidth));
				result.push(buildBottomStrip(width));

				return result;
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new OpenCodePromptEditor(tui, theme, keybindings));
	});
}
