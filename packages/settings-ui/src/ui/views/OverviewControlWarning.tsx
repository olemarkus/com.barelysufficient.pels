import { useState } from 'preact/hooks';
import type { OverviewControlWarning } from '../overviewControlWarnings.ts';
import { dispatchOpenDeviceDetail } from '../cardActivation.ts';
import { WarningIcon } from './icons.tsx';
import { MdDialog, MdIconButton, MdTextButton } from './materialWebJSX.tsx';

const stopActivation = (event: Event): void => event.stopPropagation();

/** An icon at rest; the existing explanation and episode acknowledgement on tap. */
export const OverviewControlWarningIcon = ({ warning }: { warning: OverviewControlWarning }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { recommendation, onDismiss } = warning;
  const dismiss = (): void => {
    if (!onDismiss || busy) return;
    setBusy(true);
    void onDismiss().finally(() => setBusy(false));
  };
  const openDevice = (): void => {
    setOpen(false);
    if (recommendation.target.kind === 'device') {
      dispatchOpenDeviceDetail(recommendation.target.deviceId, 'top');
    }
  };
  return (
    <span onClick={stopActivation} onKeyDown={stopActivation} onKeyUp={stopActivation} onPointerDown={stopActivation}>
      <MdIconButton type="button" class="plan-card__control-warning-icon"
        aria-label={recommendation.title} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <WarningIcon />
      </MdIconButton>
      {open && <MdDialog open class="plan-card__control-warning-dialog" onClose={() => setOpen(false)}>
        <div slot="headline">{recommendation.title}</div>
        <div slot="content">{recommendation.body}</div>
        <div slot="actions">
          <MdTextButton type="button" onClick={openDevice}>Open device</MdTextButton>
          <MdTextButton type="button" disabled={busy || !onDismiss || undefined} onClick={dismiss}>
            {busy ? 'Dismissing…' : 'Dismiss'}
          </MdTextButton>
          <MdTextButton type="button" onClick={() => setOpen(false)}>Close</MdTextButton>
        </div>
      </MdDialog>}
    </span>
  );
};
