import {
  HomeyRequestTimeoutError,
  isHomeyRequestTimeout,
  normalizeError,
} from '../../lib/utils/errorUtils';

describe('normalizeError', () => {
  it('returns Error instances unchanged', () => {
    const error = new Error('boom');
    expect(normalizeError(error)).toBe(error);
  });

  it('wraps non-Error throwables with a stable message', () => {
    const normalized = normalizeError({ code: 'boom' });
    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.message).toBe('{"code":"boom"}');
  });
});

describe('isHomeyRequestTimeout', () => {
  it('recognises the typed timeout', () => {
    expect(isHomeyRequestTimeout(new HomeyRequestTimeoutError('PUT', '/api/x'))).toBe(true);
  });

  // The transport rethrows the original object today, but a copy that lost its
  // prototype must still classify as unknown — misreading it as a definite
  // failure is what erases an in-flight command.
  it('recognises a prototype-stripped copy by name', () => {
    const copy = new Error('HTTP PUT /api/x timed out');
    copy.name = 'HomeyRequestTimeoutError';
    expect(isHomeyRequestTimeout(copy)).toBe(true);
  });

  it.each([
    ['a generic error', new Error('SDK write failed')],
    ['an HTTP 500', new Error('HTTP 500: {"error":"Failed to change the settings."}')],
    ['null', null],
    ['a bare string that mentions a timeout', 'HTTP PUT /api/x timed out'],
  ])('rejects %s', (_label, value) => {
    expect(isHomeyRequestTimeout(value)).toBe(false);
  });
});
