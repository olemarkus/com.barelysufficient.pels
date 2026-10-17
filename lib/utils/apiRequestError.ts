/**
 * A caller's malformed API input, as opposed to a failure inside PELS. The
 * API wrapper in `api.ts` still rejects the call with it, but logs it at warn
 * as `api_request_rejected` without a stack, so error-level API logs keep
 * meaning "PELS broke". Throw it only where untrusted request input is
 * validated; everything else stays a plain error.
 *
 * It lives in `lib/utils` because both `api.ts` and the domain reader that
 * validates the request need it.
 */
export class ApiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}
