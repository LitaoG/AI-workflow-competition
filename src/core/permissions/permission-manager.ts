/**
 * The three-mode PermissionGate (Issue #151). The single
 * implementation behind `permissionMode` — the loop consumes decisions, never
 * the mode itself (agent-loop.ts's `PermissionGate` seam).
 *
 * Write classification is the tool's own `readOnly` flag: a tool that does not
 * declare itself read-only is treated as a write (the safe default — an
 * unknown or unflagged tool can never sneak a mutation past plan/build).
 */
import type { PermissionDecision, PendingConfirmation, ToolCall, ToolDefinition } from '../agent-loop.js';
import type { PermissionMode } from './modes.js';

export type ModePermissionDecision = PermissionDecision & { pending?: PendingConfirmation };

export class PermissionManager {
  private constructor(readonly mode: PermissionMode) {}

  static create(mode: PermissionMode = 'yolo'): PermissionManager {
    return new PermissionManager(mode);
  }

  check(call: ToolCall, tool: ToolDefinition | undefined): ModePermissionDecision {
    if (this.mode === 'yolo') return { ok: true };
    const readOnly = tool?.readOnly === true;
    if (readOnly) return { ok: true };
    if (this.mode === 'plan') {
      return {
        ok: false,
        reason:
          tool === undefined
            ? `plan mode: "${call.name}" is not a known tool and cannot be verified read-only`
            : `plan mode: "${call.name}" is a write operation — read-only mode allows only readOnly tools`,
      };
    }
    // build: the write needs a human confirmation before it can run.
    return {
      ok: false,
      reason: `build mode: write operation "${call.name}" requires confirmation before it runs`,
      pending: { kind: 'confirmation-required', tool: call.name, callId: call.id },
    };
  }
}

/** The gate factory consumers wire in (query-engine options). */
export function createPermissionGate(mode: PermissionMode = 'yolo'): PermissionManager {
  return PermissionManager.create(mode);
}
