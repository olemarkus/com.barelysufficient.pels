/** Physical charging-phase control, independent of the saved EV power model. */
export type ChargingPhaseCount = 1 | 3;
export type ChargingPhaseMode = 'automatic' | 'single' | 'three';
export type ChargingPhaseName = 'L1' | 'L2' | 'L3';
export type ChargingPhaseVector = Readonly<Record<ChargingPhaseName, number>>;

/** An opted-in installation; absence from the settings map leaves phases to the charger. */
export type ChargingPhaseSettings = {
  mode: ChargingPhaseMode;
  installationConfirmed: true;
};
export type ChargingPhaseSettingsMap = Readonly<Record<string, ChargingPhaseSettings>>;

/** Status is resolved by the control owner, never reconstructed from capability echoes. */
export type ChargingPhaseStatus =
  | { kind: 'charger' }
  | { kind: 'ready'; phases: ChargingPhaseCount }
  | { kind: 'waiting'; phases: ChargingPhaseCount; untilMs: number }
  | { kind: 'switching'; from: ChargingPhaseCount; to: ChargingPhaseCount }
  | { kind: 'preparing'; from: ChargingPhaseCount; to: ChargingPhaseCount }
  | { kind: 'failed'; reason: string }
  | { kind: 'releasing' };

export type ChargingPhaseRead = { kind: 'unsupported' } | {
  kind: 'supported';
  deviceId: string;
  mode: 'charger' | ChargingPhaseMode;
  installationConfirmed: boolean;
  status: ChargingPhaseStatus;
};
