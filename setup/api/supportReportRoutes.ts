import { readPelsHost } from '../../lib/app/pelsHost';
import { API_STARTING_MESSAGE, defineRoutes, type ApiContext } from './defineRoutes';

function supportReports(homey: ApiContext['homey']) {
  const host = readPelsHost(homey);
  if (!host) throw new Error(API_STARTING_MESSAGE);
  return host.supportReports;
}

export const supportReportRoutes = defineRoutes({
  support_report_prepare: ({ homey, body }: ApiContext & { body?: unknown }) => (
    supportReports(homey).prepare(body)
  ),
  support_report_get: ({ homey, params }: ApiContext & { params: { id: string } }) => (
    supportReports(homey).get(params.id)
  ),
  support_report_send: ({ homey, params, body }: ApiContext & { params: { id: string }; body?: unknown }) => (
    supportReports(homey).send(params.id, body)
  ),
});
