/**
 * A deliberate partial test double: the members a test provides are typechecked
 * against the real `T` (so a production rename or signature change breaks the
 * spec loudly), while the members the exercised path never touches are simply
 * absent — exactly what the ad-hoc `as any` stubs this replaces produced at
 * runtime, minus the type hole. The single widening cast lives here, once,
 * instead of at every call site.
 */
export function partialDouble<T>(partial: Partial<T>): T {
  return partial as T;
}
