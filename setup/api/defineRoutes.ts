import type { AppContext } from '../../lib/app/appContext';
import { readPelsHost } from '../../lib/app/pelsHost';
import { ApiRequestError } from '../../lib/utils/apiRequestError';
import { normalizeError } from '../../lib/utils/errorUtils';

/** What the Homey app-API transport hands every handler, before any route-specific `body`/`query`/`params`. */
export type ApiContext = {
  homey: AppContext['homey'];
};

/** The answer a route gives while the runtime it reads is not wired yet. */
export const API_STARTING_MESSAGE = 'PELS is starting. Try again shortly.';

type RouteHandler<Ctx extends ApiContext> = (ctx: Ctx) => unknown;

// Wrap an async API handler so any thrown error is logged through the runtime's
// structured pino logger before the rejection propagates to the Homey API
// transport. Without this, handler exceptions become opaque "Network request
// failed" responses on the client and never reach `/tmp/pels`, leaving the
// failure undiagnosable.
//
// During app restart `homey.app` (or its structured logger) may not be wired
// yet; fall back to `console.error` so the cause still lands in the app's
// stderr log instead of disappearing because no logger was reachable.
//
// The handler's own context type (its `body`, `query` or `params`) is restored
// on the table by `LoggedRoutes`; the wrapper itself only reads `homey`.
const withApiLogging = (
  name: string,
  handler: RouteHandler<never>,
) => async (ctx: ApiContext): Promise<unknown> => {
  try {
    return await handler(ctx as never);
  } catch (error) {
    const logger = readPelsHost(ctx.homey)?.getApiStructuredLogger();
    if (!logger) {
      console.error(`api ${name} failed`, error);
    } else if (error instanceof ApiRequestError) {
      // The caller's input was malformed: reject it without reporting a PELS failure.
      logger.warn({ event: 'api_request_rejected', handler: name, reason: error.message });
    } else {
      logger.error({ event: 'api_handler_failed', handler: name, err: normalizeError(error) });
    }
    throw error;
  }
};

type LoggedRoutes<Routes> = {
  [Name in keyof Routes]: Routes[Name] extends (ctx: infer Ctx) => infer R
    ? (ctx: Ctx) => Promise<Awaited<R>>
    : never;
};

/**
 * One endpoint family's route table, keyed by the route name declared under
 * `api` in `.homeycompose/app.json`. Each handler is wrapped in
 * `withApiLogging` under its own key, so the name a failure is logged with
 * cannot drift from the route that failed. `api.ts` spreads the tables;
 * `npm run api:manifest-parity` checks the union against the manifest.
 */
export const defineRoutes = <Routes extends { [Name in keyof Routes]: RouteHandler<never> }>(
  routes: Routes,
): LoggedRoutes<Routes> => {
  const names = Object.keys(routes) as Array<keyof Routes & string>;
  return Object.fromEntries(
    names.map((name) => [name, withApiLogging(name, routes[name])]),
  ) as LoggedRoutes<Routes>;
};
