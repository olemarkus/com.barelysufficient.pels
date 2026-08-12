export type ReleasedOpposingCommand =
  | { kind: 'binary_off'; desired: boolean }
  | { kind: 'target_fallback'; desired: number }
  | { kind: 'step_fallback'; desiredStepId: string };

export const hasReleasedOpposingCommand = (
  released: ReleasedOpposingCommand | undefined,
  kind: ReleasedOpposingCommand['kind'],
): boolean => released?.kind === kind;
