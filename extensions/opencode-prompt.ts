import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function fitBorder(
	left: string,
	right: string,
	width: number,
	border: (text: string) => string,
	fill: (text: string) => string = border,
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	let leftText = left;
	let rightText = right;
	const fixedWidth = 0;
	const minimumGap = 2;

	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${leftText}${fill("─".repeat(gapWidth))}${rightText}`;
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
	const modelId = path.pop() ?? model.id;
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

export default function (pi: ExtensionAPI) {
	let isWorking = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	let runStartedAt: number | undefined;
	let lastCompletion: string | undefined;
	let refreshBranch: (() => Promise<void>) | undefined;
	const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
		}, 80);
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
				if (width < 6) return super.render(width);

				const innerWidth = width - 2;
				const theme = ctx.ui.theme;
				const thinking = pi.getThinkingLevel();
				const accentRail = theme.getThinkingBorderColor(thinking);
				const mutedBorder = (text: string) => theme.fg("borderMuted", text);

				const originalBorderColor = this.borderColor;
				this.borderColor = mutedBorder;
				const innerLines = super.render(innerWidth);
				this.borderColor = originalBorderColor;

				if (innerLines.length < 2) return innerLines;

				const identity = formatModelIdentity(ctx.model);
				const model = theme.fg("muted", identity.name);
				const attribution = theme.fg("dim", identity.attribution);
				const reasoning = accentRail(theme.bold(thinking));

				const topLeft = isWorking ? theme.fg("accent", ` ${spinnerFrames[spinnerIndex]} `) : "";
				const bottomLeft = ` ${model}${attribution ? ` · ${attribution}` : ""} · ${reasoning} `;
				const cwd = formatCwd(ctx.cwd);
				const completion = lastCompletion ? `${lastCompletion} · ` : "";
				const location = `${cwd.leaf}${branch ? `:${branch}` : ""}`;
				const bottomRight =
					theme.fg("dim", ` ${completion}${formatContext(ctx)} · `) +
					theme.fg("muted", location) +
					" ";

				const topFill = fitBorder(topLeft, "", innerWidth, mutedBorder);
				const bottomFill = fitBorder(bottomLeft, bottomRight, innerWidth, mutedBorder);

				const result: string[] = [];
				result.push(accentRail("┌") + topFill + mutedBorder("┐"));

				for (let i = 1; i < innerLines.length - 1; i++) {
					result.push(accentRail("│") + innerLines[i] + mutedBorder("│"));
				}

				result.push(accentRail("└") + bottomFill + mutedBorder("┘"));
				return result;
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new OpenCodePromptEditor(tui, theme, keybindings));
	});
}
