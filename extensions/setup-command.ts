import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// uv python install + pip can take a while on a cold cache.
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

export default function setupCommand(pi: ExtensionAPI) {
  pi.registerCommand("setup", {
    description: "Provision the PTC Python 3.14 venv via uv (runs setup.sh)",
    handler: async (_args, ctx) => {
      const agentDir = getAgentDir();
      const script = join(agentDir, "setup.sh");
      const notify = (msg: string, type: "info" | "warning" | "error" = "info") => ctx.ui.notify(msg, type);

      notify("Running setup.sh (uv → Python 3.14 → PTC venv)…");
      try {
        const result = await pi.exec("bash", [script], { cwd: agentDir, timeout: SETUP_TIMEOUT_MS });
        const tail = (result.stdout || "").trim().split("\n").slice(-2).join(" | ");
        if (result.code === 0) {
          notify(tail ? `Setup complete. ${tail}` : "Setup complete.");
        } else {
          notify(`Setup failed (exit ${result.code}). ${(result.stderr || "").trim().slice(-400)}`, "error");
        }
      } catch (error) {
        notify(`Setup error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
