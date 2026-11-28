/** The Deye Cloud connection for Main's EV Smart tasks. Credentials are write-only. */
export type DeyeDischargeHoldSetup = {
  region: 'eu' | 'am' | 'india';
  email: string;
  password: string;
  appId: string;
  appSecret: string;
  deviceSn: string;
  acknowledgeRisk: true;
};

export type DeyeDischargeHoldStatus = {
  enabled: boolean;
  /** Whether the settings page shows the Deye card: a saved connection, or the hidden offer switch. */
  offered: boolean;
  state: 'disabled' | 'ready' | 'pending' | 'held' | 'hold_failed' | 'unavailable' | 'recovery_required';
  region?: DeyeDischargeHoldSetup['region'];
  deviceSn?: string;
  originalLimitA?: number;
  orderId?: string;
};
