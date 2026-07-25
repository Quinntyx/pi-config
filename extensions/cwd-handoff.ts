import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Cooperates with the `pi` fish wrapper to leave the parent shell in Pi's
 * effective cwd after exit. A child process cannot chdir its parent directly.
 */
export default function cwdHandoff(pi: ExtensionAPI) {
  const handoffFile = process.env.PI_CWD_HANDOFF_FILE;
  if (!handoffFile) return;

  pi.on("session_start", async (_event, ctx) => {
    try {
      await writeFile(handoffFile, `${ctx.cwd}\n`, { mode: 0o600 });
    } catch {
      // The shell wrapper may have disappeared; cwd handoff is best-effort.
    }
  });
}
