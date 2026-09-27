/**
 * The finiteness guard, for the runtime and the settings UI alike. Import it
 * rather than hand-rolling another copy.
 */
export const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);
