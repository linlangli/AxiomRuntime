export type ClaudePermissionMode = "readOnly" | "default" | "acceptEdits" | "bypassPermissions";

export type ProcessIdentityOptions = {
  uid?: number | null;
};

export type ClaudePermissionResolution = {
  requestedMode: ClaudePermissionMode;
  effectiveMode: ClaudePermissionMode;
  privileged: boolean;
  constrained: boolean;
  reason: "root_bypass_permissions_unsupported" | null;
};

export const CLAUDE_ROOT_PERMISSION_WARNING =
  "Claude bypass permissions is unavailable while Axiom Runtime runs as root; using default permissions. Run `ai` as a non-root user to enable auto mode.";

export function getProcessUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

export function isPrivilegedProcess(options: ProcessIdentityOptions = {}): boolean {
  const uid = options.uid === undefined ? getProcessUid() : options.uid;
  return uid === 0;
}

export function resolveClaudePermissionMode(
  requestedMode: ClaudePermissionMode,
  options: ProcessIdentityOptions = {}
): ClaudePermissionResolution {
  const privileged = isPrivilegedProcess(options);
  const constrained = privileged && requestedMode === "bypassPermissions";
  return {
    requestedMode,
    effectiveMode: constrained ? "default" : requestedMode,
    privileged,
    constrained,
    reason: constrained ? "root_bypass_permissions_unsupported" : null
  };
}
