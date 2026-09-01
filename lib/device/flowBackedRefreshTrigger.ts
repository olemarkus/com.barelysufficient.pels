/**
 * The `flow_backed_device_refresh_requested` trigger card, resolved.
 *
 * A Flow card can be genuinely absent — an older Homey, a partial install —
 * and the caller must then do nothing rather than fabricate a no-op trigger.
 * That is a semantic result, not a nullable: the wiring layer owns the SDK
 * lookup and every way it can fail (an absent `homey.flow`, an absent method, a
 * throwing call), and hands the device layer one of these two answers.
 */
export type FlowBackedRefreshTrigger =
  | { state: 'available'; trigger: (state: { deviceId: string }) => Promise<unknown> }
  | { state: 'unavailable' };
