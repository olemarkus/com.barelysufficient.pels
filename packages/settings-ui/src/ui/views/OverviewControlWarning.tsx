import type { OverviewControlWarning } from '../overviewControlWarnings.ts';
import { dispatchOpenDeviceDetail } from '../cardActivation.ts';
import { OverviewDeviceWarningIcon } from './OverviewDeviceWarning.tsx';

export const OverviewControlWarningIcon = ({ warning }: { warning: OverviewControlWarning }) => {
  const { recommendation, onDismiss } = warning;
  const openDevice = (): void => {
    if (recommendation.target.kind === 'device') {
      dispatchOpenDeviceDetail(recommendation.target.deviceId, recommendation.target.focus ?? 'top');
    }
  };
  return <OverviewDeviceWarningIcon title={recommendation.title} body={recommendation.body}
    onOpenDevice={openDevice} acknowledgement={{ onDismiss }} />;
};
