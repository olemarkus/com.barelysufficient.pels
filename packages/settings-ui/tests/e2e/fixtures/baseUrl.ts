export type E2EBaseURLEnv = {
  PELS_E2E_BASE_URL?: string;
  PELS_E2E_PORT?: string;
  PELS_E2E_SERVER_PORT?: string;
};

export const resolveE2EBaseURL = (env: E2EBaseURLEnv = process.env): string => {
  if (env.PELS_E2E_BASE_URL) {
    return env.PELS_E2E_BASE_URL;
  }

  const explicitPort = env.PELS_E2E_PORT;
  const port = explicitPort && explicitPort !== '0'
    ? explicitPort
    : (env.PELS_E2E_SERVER_PORT ?? '4173');

  return `http://127.0.0.1:${port}`;
};
