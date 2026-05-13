export const isHomeyTransportErrorMessage = (message: string): boolean => {
  const lower = message.toLowerCase();
  const isMissingHomeyApiAdapter = /\bhomey api (delete|get|post|put) \S+ not available\b/i.test(message);
  return lower.includes('homey sdk not ready')
    || lower.includes('network request failed')
    || lower.includes('socket hang up')
    || lower.includes('missing app id')
    || isMissingHomeyApiAdapter
    || lower.includes('callback-only signature not supported')
    || lower.includes('timeout')
    || lower.includes('cannot get /api/app/')
    || lower.includes('cannot post /api/app/')
    || lower.includes('cannot put /api/app/')
    || lower.includes('cannot delete /api/app/');
};
