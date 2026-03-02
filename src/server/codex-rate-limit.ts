export type CodexRateLimitWindow = {
  usedPercent: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
};

export type CodexCreditsSnapshot = {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string | null;
};

export type CodexRateLimitSnapshot = {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  credits?: CodexCreditsSnapshot | null;
};

export type CodexRateLimitsResponse = {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
};

export type CodexCapacityDecision = {
  shouldWait: boolean;
  waitMs?: number;
  reason?: string;
  snapshot?: CodexRateLimitSnapshot;
};

export function formatCodexRateLimitSnapshot(snapshot: CodexRateLimitSnapshot) {
  const primaryLeft = snapshot.primary ? Math.max(0, 100 - snapshot.primary.usedPercent) : undefined;
  const secondaryLeft = snapshot.secondary ? Math.max(0, 100 - snapshot.secondary.usedPercent) : undefined;
  const primaryReset = formatResetAt(snapshot.primary?.resetsAt);
  const secondaryReset = formatResetAt(snapshot.secondary?.resetsAt);
  const parts = [
    `Codex usage preflight${snapshot.limitName ? ` for ${snapshot.limitName}` : ''}:`,
    primaryLeft === undefined ? undefined : `5h left ${primaryLeft}%${primaryReset ? ` (resets ${primaryReset})` : ''}`,
    secondaryLeft === undefined ? undefined : `weekly left ${secondaryLeft}%${secondaryReset ? ` (resets ${secondaryReset})` : ''}`,
    snapshot.credits ? `credits ${snapshot.credits.unlimited ? 'unlimited' : snapshot.credits.hasCredits ? 'available' : 'empty'}` : undefined
  ].filter(Boolean);
  return parts.join(' ');
}

export function getCodexCapacityDecision(
  payload: CodexRateLimitsResponse,
  codexModel: string,
  nowMs: number
): CodexCapacityDecision {
  const snapshot = selectCodexRateLimitSnapshot(payload, codexModel);
  if (!snapshot) {
    return { shouldWait: false };
  }

  const exhaustedResets = [
    shouldWaitForWindow(snapshot.primary) ? snapshot.primary?.resetsAt : undefined,
    shouldWaitForWindow(snapshot.secondary) ? snapshot.secondary?.resetsAt : undefined
  ].filter((value): value is number => typeof value === 'number' && value > 0);

  if (!exhaustedResets.length) {
    return { shouldWait: false, snapshot };
  }

  const waitUntilMs = Math.max(...exhaustedResets) * 1000;
  const waitMs = waitUntilMs - nowMs + 60_000;
  if (waitMs <= 0) {
    return { shouldWait: false, snapshot };
  }

  const reasons = [];
  if (shouldWaitForWindow(snapshot.primary)) {
    reasons.push('5h limit below 1%');
  }
  if (shouldWaitForWindow(snapshot.secondary)) {
    reasons.push('weekly limit below 1%');
  }

  return {
    shouldWait: true,
    waitMs,
    reason: `${reasons.join(' and ')} for ${snapshot.limitName ?? snapshot.limitId ?? 'selected Codex model'}.`,
    snapshot
  };
}

function shouldWaitForWindow(window?: CodexRateLimitWindow | null) {
  if (!window) {
    return false;
  }
  return 100 - window.usedPercent < 1;
}

function selectCodexRateLimitSnapshot(payload: CodexRateLimitsResponse, codexModel: string) {
  if (codexModel === 'gpt-5.3-codex-spark') {
    const spark = Object.values(payload.rateLimitsByLimitId ?? {}).find((snapshot) =>
      (snapshot.limitName ?? '').toLowerCase().includes('spark')
    );
    if (spark) {
      return spark;
    }
  }

  return payload.rateLimitsByLimitId?.codex ?? payload.rateLimits;
}

function formatResetAt(resetsAt?: number | null) {
  if (!resetsAt) {
    return undefined;
  }
  return new Date(resetsAt * 1000).toISOString();
}
