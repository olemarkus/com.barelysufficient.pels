/**
 * Producer-resolved home scope of a settings-UI read model — the complete
 * classification of a `?homeId=` request, so no consumer re-derives it.
 *
 * ABSENT on an unscoped read: the payload is then byte-identical to the
 * pre-multi-home shape, which is what keeps a single-home install (and every
 * whole-home surface) on exactly the response it has always had.
 *
 * `unavailable` folds every non-serving case the producer knows about — a
 * malformed or refused id, an unknown sub-home, and a home whose runtime is not
 * (or no longer) wired. Render it as "no data for this home"; never substitute
 * another home's values, and never read the flat payload fields as if they were
 * that home's real state (they are the empty shape, not measurements).
 */
export type SettingsUiHomeScope =
  | { readonly state: 'resolved'; readonly homeId: string }
  | { readonly state: 'unavailable' };

/**
 * A `?homeId=`-scoped read model, resolved to a shape whose flat fields are
 * unreachable until the scope is discriminated.
 *
 * The scoped endpoints answer every non-serving case (refused id, unknown
 * sub-home, unwired runtime) with the EMPTY payload shape plus
 * `homeScope: unavailable` — so a consumer that reads the flat fields first
 * cannot tell "no data for this home" from a measured idle, and would render
 * fabricated zeros as that home's history. Resolving through this helper makes
 * that mistake unrepresentable: `payload` exists only on the `served` arm.
 */
export type HomeScopedRead<T> =
  | { readonly state: 'served'; readonly payload: T }
  | { readonly state: 'unavailable' };

/**
 * Classify a payload fetched through a `?homeId=` URI. ONLY for scoped reads:
 * a whole-home payload carries no `homeScope` member by design, and this
 * helper deliberately classifies that absence as `unavailable` too — a scoped
 * request answered without a scope block is a producer that ignored the query,
 * and rendering its whole-home figures under a sub-home's name would be worse
 * than showing nothing.
 *
 * `expectedHomeId` is the id the CONSUMER asked for. A resolved scope block
 * naming any other home is a producer answering for the wrong home — a
 * malformed or misrouted payload, not a servable answer — and is classified
 * `unavailable` for the same reason: its figures would render under the
 * selected home's name.
 *
 * Value module for the settings UI (and future scoped consumers, e.g. the
 * per-home Overview). The runtime backend must keep importing this package
 * type-only: the sanitize step deletes `packages/contracts` from the shipped
 * bundle, so a backend value import crashes boot.
 */
export const resolveHomeScopedRead = <T extends { homeScope?: SettingsUiHomeScope }>(
  payload: T | null | undefined,
  expectedHomeId: string,
): HomeScopedRead<T> => (
  payload !== null && payload !== undefined
    && payload.homeScope?.state === 'resolved'
    && payload.homeScope.homeId === expectedHomeId
    ? { state: 'served', payload }
    : { state: 'unavailable' }
);
