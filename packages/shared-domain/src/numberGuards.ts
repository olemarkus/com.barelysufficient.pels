/**
 * Browser-safe finiteness guard for shared-domain resolvers.
 *
 * Duplicates `lib/utils/appTypeGuards.isFiniteNumber` BY DESIGN: shared-domain
 * is a browser-safe leaf package and must not import the runtime backend
 * (`no-lib-to-setup` / settings-UI boundary rules), so consolidating across
 * that boundary is architecturally banned. Package-local consumers should
 * import from here instead of hand-rolling further copies.
 */
export const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);
