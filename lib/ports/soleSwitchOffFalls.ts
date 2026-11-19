/**
 * How far the whole-home reading fell after PELS switched one device off with
 * nothing else decided around it: the home meter's witness of what that device
 * drew.
 *
 * The shed relief audit (`lib/plan/shedding/shedReliefAudit.ts`) reads each
 * fall a minute after the decision and hands the lone switch-offs to the
 * recorder here. The device layer keeps them per device and compares them with
 * the figure PELS plans that device with (`lib/device/powerFigureCheck.ts`).
 * Setup hands one recorder to every home's plan builder.
 */
export type SoleSwitchOffFall = {
  deviceId: string;
  /** When the switch-off was decided. */
  decidedAtMs: number;
  /** Whole-home draw at the decision minus the draw a minute later; negative when the home rose. */
  fallKw: number;
};

export type SoleSwitchOffFallRecording = {
  recordSoleSwitchOffFall(fall: SoleSwitchOffFall): void;
};
