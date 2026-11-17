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
