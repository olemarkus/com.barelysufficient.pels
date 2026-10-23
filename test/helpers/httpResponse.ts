import { partialDouble } from './partialDouble';

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

export const httpResponse = (body: unknown, status = 200): FetchResponse => partialDouble<FetchResponse>({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});
