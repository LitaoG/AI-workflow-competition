export interface CheckResult {
  valid: boolean;
  violations: string[];
}

export interface IssueLinkResult extends CheckResult {
  issueNumber: string | null;
}

export interface CoolingResult extends CheckResult {
  elapsedSeconds?: number | null;
  remainingSeconds?: number;
  bypassed?: boolean;
  reason?: string | null;
}

export interface ReviewComment {
  user?: string;
  author?: { login: string };
  body: string;
  createdAt?: string;
  created_at?: string;
}

export interface ReviewCommentsResult extends CheckResult {
  unresolvedCount: number;
  unresolvedReviews: Array<{
    author: string;
    snippet: string;
    createdAt?: string;
  }>;
}

export interface CleanlinessResult {
  clean: boolean;
  status: string;
  violations: string[];
}

export function checkIssueLinkage(content: string): IssueLinkResult;
export function checkFingerprint(content: string): CheckResult;

export interface TapLogBindingResult extends CheckResult {
  /** The .gate/tap.log TAP summary when it could be parsed; undefined otherwise. */
  tap?: { tests: number; pass: number; fail: number };
}

/**
 * Issue #158: binds the PR body's fingerprint numbers to the real npm-test TAP
 * summary in .gate/tap.log — a shape that never faced the run proves nothing.
 */
export function checkTapLogBinding(content: string, tapLogPath?: string): TapLogBindingResult;

export function checkCoolingPeriod(
  createdAtIso: string,
  options?: { now?: Date; minSeconds?: number; bypassReason?: string | null }
): CoolingResult;
export function checkReviewComments(comments: ReviewComment[]): ReviewCommentsResult;
export function checkWorktreeCleanliness(cwd?: string): CleanlinessResult;

export interface FailureNamingResult extends CheckResult {
  failedCount: number;
}

export interface NoCommentClaimsResult extends CheckResult {
  violations: string[];
}

export interface CiGateResult extends CheckResult {
  violations: string[];
}

/**
 * B③ (Issue #136): blocks when the head commit's CI `gate` check-run concluded
 * `failure` — the mechanical prevention for red-gate merges (#119 class).
 * null (pending / no check-run) does not block; enforce_admins covers that window.
 */
export function checkCiGateConclusion(conclusion: string | null | undefined): CiGateResult;

export declare const FAST_MERGE_FLOOR_SECONDS = 600;
export declare const DEFAULT_COOLING_SECONDS = 900;
export declare const REVIEW_MARKERS: string[];
export declare const RESOLVE_KEYWORDS: string[];
export declare const FORBIDDEN_PLACEHOLDERS: string[];

export function checkFailureNaming(content: string): FailureNamingResult;
export function checkNoCommentClaims(
  prBody: string,
  issueComments?: Array<{ fromIssue?: number | string; author?: string; body?: string }>
): NoCommentClaimsResult;

/**
 * Directories under the sibling AI-workflow-worktrees/ root whose `git
 * rev-parse --git-dir` no longer resolves — orphan worktree shells (Issue #67)
 * that must be deleted on sight (AGENTS.md §1.5). Empty on CI clones.
 */
export function findOrphanWorktrees(cwd?: string): string[];
