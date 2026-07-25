/**
 * block-find-grep.ts — Hard-block standalone `find` and `grep` commands.
 *
 * Forces the agent to use ripgrep (`rg`) instead: `rg` replaces `grep`, and
 * `rg --files` / `rg -l` / `rg -g '<glob>' --files` replace `find`.
 *
 * Matches `find`/`grep` as command tokens anywhere in the command — including
 * after shell separators (&& || ; | newline), behind wrappers
 * (sudo/time/nice/env/xargs/nohup/command), and via absolute paths
 * (/bin/grep, /usr/bin/find). This closes the gap that the pi-permissions
 * `Bash(grep *)` / `Bash(find *)` deny rules leave open (those only catch
 * commands that START with grep/find, not mid-pipeline usage).
 *
 * Intentionally NOT blocked:
 *   - `git grep`           — git subcommand (the char before `grep` is a space
 *                            after `git`, not a separator/start, so no match)
 *   - `git log --grep=…`   — flag, not the binary; "grep" is followed by "=", not whitespace
 *   - substring words       — findutils, --grep=, etc. never match as tokens
 *
 * Rare false positive: a path segment literally named `find`/`grep` followed by
 * a space (e.g. `cd code/grep && …`). Accepted trade-off for path-bypass coverage.
 *
 * Accident-guardrail, not a security boundary.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Group 1 = separator/start, group 2 = the matched binary (find|grep).
	const RE =
		/(^|[;&|\n/])\s*(?:(?:sudo|time|nice|env|xargs|nohup|command)\s+)*(find|grep)(?=\s|$)/;

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const command = (event.input?.command as string | undefined) ?? "";
		if (!command) return undefined;

		const match = command.match(RE);
		if (!match) return undefined;
		const cmd = match[2]; // "find" or "grep"

		const hint =
			cmd === "find"
				? "Replace `find` with `rg --files` (list files), `rg -g '<glob>' --files` (filter by name), or `rg -l <pat>` (files containing a pattern)."
				: "Replace `grep <pat>` with `rg <pat>`.";

		return {
			block: true,
			reason:
				`\`${cmd}\` is blocked by policy — use ripgrep (`rg`) instead. ${hint} ` +
				"This covers every form (grep, sudo grep, find, xargs grep, /bin/grep, …, and " +
				"mid-pipeline usage). `git grep` and `git log --grep=` remain allowed. If ripgrep " +
				"genuinely cannot do the job, stop and ask the user.",
		};
	});
}
