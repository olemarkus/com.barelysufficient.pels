import pino from 'pino';

const PINO_ERROR_LEVEL = 50;

export type HomeyLogCallbacks = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/**
 * Pino writes one complete JSON line and sets level metadata before each write.
 * Forward synchronously: a buffered stream could read a later line's metadata.
 */
export class HomeyLogDestination implements pino.DestinationStream {
  readonly [pino.symbols.needsMetadataGsym] = true;
  lastLevel = 0;

  constructor(private readonly callbacks: HomeyLogCallbacks) {}

  write(line: string): void {
    const level = this.lastLevel;
    // createRootLogger keeps Pino's numeric level as the first field and
    // reserves it from payloads. Slice off that field, keeping the JSON body
    // exactly as Pino serialized it (including bindings and error serializers).
    const firstComma = line.indexOf(',');
    const forwarded = firstComma === -1 ? '{}' : `{${line.slice(firstComma + 1).trimEnd()}`;
    try {
      if (level >= PINO_ERROR_LEVEL) this.callbacks.error(forwarded);
      else this.callbacks.log(forwarded);
    } catch {
      // Homey logging failures must never throw into app code.
    }
  }
}

export const createHomeyDestination = (callbacks: HomeyLogCallbacks): HomeyLogDestination => (
  new HomeyLogDestination(callbacks)
);
