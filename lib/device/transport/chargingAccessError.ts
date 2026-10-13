export type AccessFailure = 'permission_denied' | 'unavailable';

/** Deliberately excludes HTTP response bodies and credentials from errors. */
export class ChargingAccessError extends Error {
  constructor(readonly reason: AccessFailure) {
    super(reason === 'permission_denied'
      ? 'The Homey API key needs Flow permission. Create or replace it in Homey Settings → API Keys.'
      : 'Homey charging access is unavailable. Check the key and try again.');
    this.name = 'ChargingAccessError';
  }
}
