/**
 * Permission modes (Issue #151).
 *
 * Three runtime postures for the core agent loop's tool calls, layered on the
 * Phase 3 `PermissionGate` seam (agent-loop.ts) — the loop itself never learns
 * the mode, it only sees decisions:
 *
 * - `plan`  — read-only. Every call to a tool that is not provably
 *   `readOnly` is denied; nothing can mutate state while planning.
 * - `build` — writes require an explicit human confirmation. A write call is
 *   denied with a structured `pending` marker so an interactive host can
 *   surface the confirmation and re-issue the call; read-only tools run.
 * - `yolo`  — everything runs (the pre-permission default, `allowAllPermissions`
 *   semantics preserved verbatim).
 *
 * The wider ecosystem defines five modes; this repo ships three names
 * and maps the rest only when a real consumer needs them (#151 明确不做).
 */
export type PermissionMode = 'plan' | 'build' | 'yolo';

export const PERMISSION_MODES: readonly PermissionMode[] = ['plan', 'build', 'yolo'];

/** Parse a user-supplied mode, failing loudly on an unknown value. */
export function parsePermissionMode(raw: string | undefined): PermissionMode {
  if (raw === undefined || raw === '') return 'yolo';
  if ((PERMISSION_MODES as readonly string[]).includes(raw)) return raw as PermissionMode;
  throw new Error(`unknown permission mode "${raw}" — expected one of ${PERMISSION_MODES.join(' | ')}`);
}
