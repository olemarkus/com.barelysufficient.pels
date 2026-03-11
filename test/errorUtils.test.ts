import { normalizeError } from '../lib/utils/errorUtils';

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
