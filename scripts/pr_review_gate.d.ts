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
