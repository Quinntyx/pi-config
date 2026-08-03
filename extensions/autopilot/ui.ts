/**
 * ui.ts — status-bar footer management for autopilot.
 *
 * Uses ctx.ui.setStatus("autopilot", text) to surface autopilot state in the
 * footer. Pass undefined to clear. See ARCHITECTURE.md §7.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "autopilot";

/** Primary mode is active (sidecar spawned, gate armed). */
export function autopilotOn(ctx: ExtensionContext): void {
  ctx.ui.setStatus(STATUS_KEY, "autopilot on");
}

/** Pilot (sidecar) mode is active. */
export function autopilotPilot(ctx: ExtensionContext): void {
  ctx.ui.setStatus(STATUS_KEY, "autopilot pilot");
}

/** Clear the autopilot status (shutdown / not running). */
export function autopilotOff(ctx: ExtensionContext): void {
  ctx.ui.setStatus(STATUS_KEY, undefined);
}