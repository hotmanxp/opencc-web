export type PrReviewState =
  | 'approved'
  | 'pending'
  | 'changes_requested'
  | 'draft'
  | 'merged'
  | 'closed'

export type PrStatus = {
  number: number
  url: string
  reviewState: PrReviewState
}

/**
 * Derive review state from GitHub API values.
 * Draft PRs always show as 'draft' regardless of reviewDecision.
 * reviewDecision can be: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty string.
 */
export function deriveReviewState(
  isDraft: boolean,
  reviewDecision: string,
): PrReviewState {
  if (isDraft) return 'draft'
  switch (reviewDecision) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    default:
      return 'pending'
  }
}

export async function fetchPrStatus(): Promise<PrStatus | null> {
  // DISABLED 2026-06-06: this fork does not use GitHub PR integration.
  // The probe spawned `gh pr view` every 60s via usePrStatus hook,
  // producing `spawn gh ENOENT` in debug logs. The result fed a PR
  // review state footer pill (PromptInputFooterLeftSide.tsx:266) that
  // is not useful in a non-GitHub workflow.
  // To re-enable: remove this block and restore the original body.
  return null
}
