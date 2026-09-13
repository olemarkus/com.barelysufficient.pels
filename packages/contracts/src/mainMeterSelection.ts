/**
 * Producer-resolved Main meter selection.
 *
 * `resolved` always names one explicit meter device id — there is no Automatic.
 *
 * The two non-resolved states both fence control (PELS cannot do capacity
 * control without knowing which meter it reads) and differ only in whether
 * asking again can change the answer:
 *
 * - `unconfigured` — proven nothing is stored: a healthy, non-empty key list
 *   that does not list the key. Re-reading will return the same thing until the
 *   owner picks a meter (or boot-time sole-meter adoption picks one for them),
 *   so this must never drive a retry.
 * - `unavailable` — the read could not be trusted: a transient SDK miss, a
 *   malformed stored value, a legacy stored-null selection, an empty key list,
 *   or a throw. Re-reading may well succeed.
 *
 * Collapsing the two is how a retry loop ended up re-reading a setting once a
 * minute, for the life of the app, on every install that had not chosen a
 * meter. Raw SDK shapes and errors never cross this contract.
 */
export type MainMeterSelection =
  | { state: 'resolved'; meterDeviceId: string }
  | { state: 'unconfigured' }
  | { state: 'unavailable' };
