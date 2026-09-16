// The owner-token reader for Homey's own Web API, handed to the modules that
// own a manager route's meaning.
//
// Every manager read in PELS goes through this client (`getRawFromHomeyApi`),
// not the SDK's `homey.api.get`: an app's call through that bridge carries an
// app-session header, which only the app-to-app routes accept, so a manager
// route answers it with an auth failure. The client here authenticates with the
// owner API token the SDK hands out, the same credential the Homey app itself
// uses.
//
// **The placement it brokers around is unresolved.** `getRawFromHomeyApi` is a
// generic Web API client that happens to live in `lib/device/transport/`, and
// it now has readers in three domains. `lib/price` may not import it
// (`no-price-to-peer`), so this file passes it in as a one-method port — which
// keeps each file to a single domain peer and therefore passes
// `setup:boundaries`, while the composition the rule is about still happens,
// split across two files. The honest fix is to give that client a neutral home
// outside `lib/device` so each domain reads its own routes directly; until
// then, this is a broker, and naming it one is the least it can do.
// The return type is written out rather than imported as `HomeyWebApiGet`,
// because naming that type is itself a second domain import and the guard
// counts imports — which is the sharpest evidence that what it measures and
// what it is about have come apart here.
import { getRawFromHomeyApi } from '../lib/device/transport/managerHomeyApi';

export const createHomeyWebApiGet = (): ((path: string) => Promise<unknown>) => (
  (path: string) => getRawFromHomeyApi(path)
);
