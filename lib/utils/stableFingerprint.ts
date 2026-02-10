type FingerprintNode =
  | readonly ['null']
  | readonly ['undefined']
  | readonly ['string', string]
  | readonly ['number', string]
  | readonly ['boolean', boolean]
  | readonly ['bigint', string]
  | readonly ['symbol', string]
  | readonly ['function', string]
  | readonly ['array', readonly FingerprintNode[]]
  | readonly ['object', readonly (readonly [string, FingerprintNode])[]]
  | readonly ['circular']
  | readonly ['unknown', string];

const serializeNumber = (value: number): string => {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return String(value);
};

const getPrimitiveNode = (value: unknown): FingerprintNode | null => {
  if (value === null) return ['null'];
  if (value === undefined) return ['undefined'];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'number') return ['number', serializeNumber(value)];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'symbol') return ['symbol', value.toString()];
  if (typeof value === 'function') return ['function', value.name || 'anonymous'];
  return null;
};

const serializeWithSeenTracking = (
  value: object,
  seen: WeakSet<object>,
  serialize: () => FingerprintNode,
): FingerprintNode => {
  if (seen.has(value)) return ['circular'];
  seen.add(value);
  try {
    return serialize();
  } finally {
    seen.delete(value);
  }
};

const toFingerprintNode = (value: unknown, seen: WeakSet<object>): FingerprintNode => {
  const primitiveNode = getPrimitiveNode(value);
  if (primitiveNode !== null) return primitiveNode;

  if (Array.isArray(value)) {
    return serializeWithSeenTracking(
      value,
      seen,
      () => ['array', value.map((entry) => toFingerprintNode(entry, seen))],
    );
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key): readonly [string, FingerprintNode] => [key, toFingerprintNode(record[key], seen)]);
    return serializeWithSeenTracking(
      record,
      seen,
      () => ['object', entries],
    );
  }

  return ['unknown', String(value)];
};

export function toStableFingerprint(value: unknown, seen: WeakSet<object> = new WeakSet<object>()): string {
  return JSON.stringify(toFingerprintNode(value, seen));
}
