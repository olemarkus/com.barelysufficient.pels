/** Standard Homey solar production cap. Resolved by the device owner. */
export type InverterControlSurface = {
  maxW: number;
  stepW: number;
  mode: 'direct' | 'switchable';
};

/** Independently dated reports; a successful command never updates these. */
export type InverterObservation = {
  production: { value: number; observedAtMs: number };
  limit: { value: number; observedAtMs: number };
  mode: { kind: 'direct' }
    | { kind: 'controlled' | 'autonomous'; value: string; observedAtMs: number };
};

