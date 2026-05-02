import type { TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import {
  deviceDetailNativeSteppedStatusHint,
  deviceDetailNativeSteppedStatusRow,
  deviceDetailNativeSteppedStatusValue,
} from '../dom.ts';

export const setDeviceDetailNativeSteppedStatus = (device: TargetDeviceSnapshot | null) => {
  const status = device?.nativeSteppedLoadStatus;
  if (
    !deviceDetailNativeSteppedStatusRow
    || !deviceDetailNativeSteppedStatusValue
    || !deviceDetailNativeSteppedStatusHint
  ) {
    return;
  }
  if (!status) {
    deviceDetailNativeSteppedStatusRow.hidden = true;
    deviceDetailNativeSteppedStatusValue.textContent = '';
    deviceDetailNativeSteppedStatusHint.textContent = '';
    return;
  }

  deviceDetailNativeSteppedStatusRow.hidden = false;
  deviceDetailNativeSteppedStatusValue.textContent = (
    status.blockedMessage ?? status.currentStepLabel ?? status.modelLabel
  );
  deviceDetailNativeSteppedStatusHint.textContent = status.blockedMessage ? status.modelLabel : '';
};
