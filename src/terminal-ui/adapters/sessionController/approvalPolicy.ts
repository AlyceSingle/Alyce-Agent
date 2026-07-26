import type { ApprovalMode } from "../../../config/runtime.js";
import type {
  PermissionEvaluation,
  PermissionRuleInput
} from "../../../core/permissions/permissionRules.js";
import type { ToolApprovalRequest } from "../../../tools/types.js";

export const AUTO_REVIEW_CONFIDENCE_THRESHOLD = 0.72;

export interface AutoReviewDecision {
  decision: "approve" | "reject";
  confidence: number;
  reason: string;
}

export function buildAutoReviewPrompt(options: {
  request: ToolApprovalRequest;
  permissionEvaluation: PermissionEvaluation;
  userRequest: string;
  approvalMode: ApprovalMode;
}): string {
  return [
    "Review this pending Alyce permission request.",
    "Return only strict JSON with keys decision, confidence, and reason.",
    "",
    JSON.stringify({
      currentApprovalMode: options.approvalMode,
      userRequest: options.userRequest,
      request: {
        kind: options.request.kind,
        toolName: options.request.toolName,
        title: options.request.title,
        summary: options.request.summary,
        details: options.request.details,
        scope: options.request.scope,
        permission: options.request.permission,
        forceAsk: options.request.forceAsk === true
      },
      permissionEvaluation: {
        action: options.permissionEvaluation.action,
        permission: options.permissionEvaluation.permission,
        pattern: options.permissionEvaluation.pattern,
        reason: options.permissionEvaluation.reason
      },
      policy:
        "Approve only if the request is necessary for the user request, low risk, and scoped. Reject destructive, secret-bearing, unrelated, broad, or ambiguous requests."
    }, null, 2)
  ].join("\n");
}

export function parseAutoReviewDecision(output: string): AutoReviewDecision | null {
  const normalized = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const jsonCandidate = normalized.startsWith("{")
    ? normalized
    : normalized.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonCandidate) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const decision = record.decision;
  const confidence = record.confidence;
  const reason = record.reason;
  if (decision !== "approve" && decision !== "reject") {
    return null;
  }

  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return null;
  }

  return {
    decision,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: typeof reason === "string" && reason.trim().length > 0
      ? reason.trim()
      : "No reason provided."
  };
}

export function buildApprovalModePermissionRules(mode: ApprovalMode): PermissionRuleInput[] {
  if (mode === "default" || mode === "auto-review") {
    return [
      {
        permission: "file.write",
        pattern: "workspace:*",
        action: "allow",
        scope: "session",
        reason: `${mode} mode allows workspace file writes.`
      },
      {
        permission: "file.edit",
        pattern: "workspace:*",
        action: "allow",
        scope: "session",
        reason: `${mode} mode allows workspace file edits.`
      },
      {
        permission: "file.patch",
        pattern: "workspace:*",
        action: "allow",
        scope: "session",
        reason: `${mode} mode allows workspace patches.`
      },
      {
        permission: "shell",
        pattern: "*",
        action: "allow",
        scope: "session",
        reason: `${mode} mode allows command execution.`
      },
      {
        permission: "powershell",
        pattern: "*",
        action: "allow",
        scope: "session",
        reason: `${mode} mode allows command execution.`
      }
    ];
  }

  if (mode === "full-access") {
    return [
      {
        permission: "*",
        pattern: "*",
        action: "allow",
        scope: "session",
        reason: "Full Access mode allows all permission requests."
      }
    ];
  }

  return [];
}

export function shouldSkipApprovalDialog(
  permissionEvaluation: Pick<PermissionEvaluation, "action"> | null | undefined,
  request: Pick<ToolApprovalRequest, "forceAsk">,
  sessionApprovalMode: ApprovalMode
): boolean {
  if (permissionEvaluation?.action === "deny") {
    return false;
  }

  if (sessionApprovalMode === "full-access") {
    return true;
  }

  return permissionEvaluation?.action === "allow" && !request.forceAsk;
}
