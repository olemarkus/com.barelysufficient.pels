/** Standard Homey solar production cap. Resolved by the device owner. */
export type InverterControlBinding = {
  maxW: number;
  stepW: number;
} & ({ mode: 'direct' } | { mode: 'switchable'; modeValues: readonly string[] });

/** A retained binding authorizes hand-back, never another production cap. */
export type InverterControlSurface = InverterControlBinding & {
  authority: 'limit_and_release' | 'release_only';
};

/** Independently dated reports; a successful command never updates these. */
export type InverterObservation = {
  production: { value: number; observedAtMs: number };
  limit: { value: number; observedAtMs: number };
  mode: { kind: 'direct' }
    | { kind: 'controlled' | 'autonomous'; value: string; observedAtMs: number };
};

