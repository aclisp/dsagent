export interface DangerousMatch {
  reason: string;
  intent: string;
  elevated: boolean;
}

export function makeDangerousMatch(
  reason: string,
  intent: string,
  elevated: boolean,
  intentIncludesElevation = false,
): DangerousMatch {
  return {
    reason,
    intent: elevated && !intentIncludesElevation
      ? `${intent} (with elevated privileges)`
      : intent,
    elevated,
  };
}

export function withIntent(match: DangerousMatch, intent: string): DangerousMatch {
  return makeDangerousMatch(match.reason, intent, match.elevated);
}
