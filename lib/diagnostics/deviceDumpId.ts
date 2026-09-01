/**
 * Distinguishes one device dump from the next.
 *
 * The dump is the artefact we ask users to send back, and it is emitted as one
 * line per section — so a reader needs a token that ties those lines together
 * and separates one press of "Log device" from the press after it.
 *
 * Process-local and monotonic: no clock and no randomness, because the id only
 * has to be unique within a single log file. It deliberately does not reset,
 * so two dumps of the SAME device in one session never share an id.
 */
let deviceDumpSequence = 0;

export const nextDeviceDumpId = (deviceId: string): string => {
  deviceDumpSequence += 1;
  return `${deviceId}#${deviceDumpSequence}`;
};
