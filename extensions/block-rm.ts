/**
 * block-rm.ts — Hard-block the `rm` command everywhere.
 *
 * Pi ships fully permissive (no built-in permission system — see docs/security.md
 * and docs/usage.md). This extension uses the `tool_call` event, which can block
 * a tool call by returning `{ block: true, reason }`, to force-reject any bash
 * invocation of the `rm` binary. The model must use `trash` instead, so deletions
 * stay recoverable via `trash-restore`.
 *
 * Matches `rm` as a command token, including:
 *   - at the start of the command          (rm foo, rm -rf bar)
 *   - after shell separators && || ; | \n   (cd x && rm y)
 *   - behind common wrappers               (sudo / time / nice / env / xargs / nohup / command rm)
 *   - via an absolute path                  (/bin/rm, ./rm)
 *
 * Intentionally NOT blocked:
 *   - `git rm`  — a git subcommand (version-controlled; use --cached to keep the file)
 *   - `rmdir`   — separate binary, removes only empty directories
 *
 * This is an accident-guardrail, not a security boundary.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const RM_RE =
		/(^|[;&|\n/])\s*(?:(?:sudo|time|nice|env|xargs|nohup|command)\s+)*rm(?=\s|$)/;

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const command = (event.input?.command as string | undefined) ?? "";
		if (!command) return undefined;

		if (RM_RE.test(command)) {
			return {
				block: true,
				reason:
					"`rm` is blocked by policy. Use `trash <path>` (installed at /usr/bin/trash) so " +
					"deletions are recoverable via `trash-restore` / `trash-list`. This covers every form " +
					"of rm (rm, rm -rf, sudo rm, xargs rm, /bin/rm, …). If you genuinely need an " +
					"unrecoverable delete, stop and ask the user to run it manually.",
			};
		}
		return undefined;
	});
}
