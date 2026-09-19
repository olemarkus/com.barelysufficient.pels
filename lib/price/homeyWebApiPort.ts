/**
 * The one capability a Homey manager-route read needs: a GET against Homey's
 * own Web API, relative to `/api`.
 *
 * Supplied by the wiring layer, which hands over the owner-token REST reader
 * every other manager read in PELS already uses (`setup/homeyWebApi.ts`).
 * Deliberately NOT the SDK's `homey.api.get`: an app's call through that bridge
 * is authenticated with an app-session header that only the app-to-app routes
 * accept, so a manager route rejects it.
 *
 * Its own module because both price readers need it — the import formula and
 * the export terms — and neither should have to import the other to name it.
 */
export type HomeyWebApiGet = (path: string) => Promise<unknown>;
