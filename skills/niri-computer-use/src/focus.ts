/**
 * Save and restore desktop focus.
 *
 * Computer-use tasks commonly switch the focused window (and often the focused
 * workspace) to reach the target. `snapshotFocus` records the original focus so
 * `restoreFocus` can give the user their window back when the task ends (e.g. a
 * kitty window running Pi). Restoration degrades gracefully: if the saved
 * window no longer exists it falls back to re-focusing its workspace.
 */
import {
  focusedWindow,
  windows,
  workspaces,
  focusWindowById,
  focusWorkspaceById,
  type ReportOptions,
} from "./state.ts";
import { AppError } from "./input.ts";

export interface FocusSnapshot {
  /** Saved before the task started; null if nothing was focused. */
  window_id: number | null;
  app_id: string | null;
  title: string | null;
  workspace_id: number | null;
}

/** Capture the currently focused window (and its workspace) for later restore. */
export async function focusSnapshot(o: ReportOptions = {}): Promise<FocusSnapshot> {
  const fw = await focusedWindow(o);
  return {
    window_id: fw?.id ?? null,
    app_id: fw?.app_id ?? null,
    title: fw?.title ?? null,
    workspace_id: fw?.workspace_id ?? null,
  };
}

export interface RestoreResult {
  /** Which kind of target was re-focused. */
  mode: "window" | "workspace";
  /** True once a follow-up query confirmed the restore took effect. */
  focus_verified: boolean;
  window_id?: number;
  workspace_id?: number;
}

/**
 * Restore a previously captured focus state and verify it.
 *
 * Preference: re-focus the original window. If that window is gone, re-focus its
 * original workspace. If neither exists anymore, raise RESTORE_TARGET_GONE.
 */
export async function restoreFocus(
  snap: FocusSnapshot,
  o: ReportOptions = {},
): Promise<RestoreResult> {
  if (snap.window_id !== null) {
    const open = await windows(o);
    if (open.some((w) => w.id === snap.window_id)) {
      await focusWindowById(snap.window_id, o);
      const fw = await focusedWindow(o);
      const ok = fw?.id === snap.window_id;
      if (!ok) {
        throw new AppError("RESTORE_FAILED", "restore of focus did not take effect", {
          expected: { window_id: snap.window_id },
          actual: fw ? { window_id: fw.id, app_id: fw.app_id } : null,
        });
      }
      return { mode: "window", focus_verified: true, window_id: snap.window_id };
    }
  }
  if (snap.workspace_id !== null) {
    const open = await workspaces(o);
    if (open.some((w) => w.id === snap.workspace_id)) {
      await focusWorkspaceById(snap.workspace_id, o);
      const after = await workspaces(o);
      const w = after.find((x) => x.id === snap.workspace_id);
      const ok = w?.is_active === true || w?.is_focused === true;
      if (!ok) {
        throw new AppError("RESTORE_FAILED", "restore of workspace did not take effect", {
          expected: { workspace_id: snap.workspace_id },
          actual: w ? { workspace_id: w.id, is_active: w.is_active } : null,
        });
      }
      return { mode: "workspace", focus_verified: true, workspace_id: snap.workspace_id };
    }
  }
  throw new AppError(
    "RESTORE_TARGET_GONE",
    "neither the saved window nor its workspace exists anymore; cannot restore focus",
    { window_id: snap.window_id ?? null, workspace_id: snap.workspace_id ?? null },
  );
}