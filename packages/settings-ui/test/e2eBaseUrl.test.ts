import { resolveE2EBaseURL } from '../tests/e2e/fixtures/baseUrl';

describe('resolveE2EBaseURL', () => {
  it('prefers an explicit base URL over port settings', () => {
    expect(resolveE2EBaseURL({
      PELS_E2E_BASE_URL: 'http://127.0.0.1:5000/custom',
      PELS_E2E_PORT: '4173',
      PELS_E2E_SERVER_PORT: '5001',
    })).toBe('http://127.0.0.1:5000/custom');
  });

  it('uses an explicit non-zero E2E port before a captured server port', () => {
    expect(resolveE2EBaseURL({
      PELS_E2E_PORT: '4173',
      PELS_E2E_SERVER_PORT: '5001',
    })).toBe('http://127.0.0.1:4173');
  });

  it('treats explicit port zero as dynamic and uses the captured server port', () => {
    expect(resolveE2EBaseURL({
      PELS_E2E_PORT: '0',
      PELS_E2E_SERVER_PORT: '5001',
    })).toBe('http://127.0.0.1:5001');
  });

  it('falls back to the legacy default port when no dynamic port is captured', () => {
    expect(resolveE2EBaseURL({})).toBe('http://127.0.0.1:4173');
  });
});
