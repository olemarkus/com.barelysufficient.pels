import { createPortal } from 'preact';
import { useState } from 'preact/hooks';
import type { OverviewControlWarning } from '../overviewControlWarnings.ts';
import { dispatchOpenDeviceDetail } from '../cardActivation.ts';
import { CloseIcon, WarningIcon } from './icons.tsx';
import { MdDialog, MdIconButton, MdTextButton } from './materialWebJSX.tsx';

const stopActivation = (event: Event): void => event.stopPropagation();

/** An icon at rest; the existing explanation and episode acknowledgement on tap. */
export const OverviewControlWarningIcon = ({ warning }: { warning: OverviewControlWarning }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { recommendation, onDismiss } = warning;
  const close = (): void => setOpen(false);
  const hide = (): void => {
    if (!onDismiss || busy) return;
    setBusy(true);
    void onDismiss().finally(() => setBusy(false));
  };
  const openDevice = (): void => {
    close();
    if (recommendation.target.kind === 'device') {
      dispatchOpenDeviceDetail(recommendation.target.deviceId, recommendation.target.focus ?? 'top');
    }
  };
  return (
    <span onClick={stopActivation} onKeyDown={stopActivation} onKeyUp={stopActivation} onPointerDown={stopActivation}>
      <MdIconButton type="button" class="plan-card__control-warning-icon"
        aria-label={recommendation.title} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <WarningIcon />
      </MdIconButton>
      {/* Mounted under the body: inside the card, the scrim would share the
          card's stacking context and leave the cards after it undimmed. */}
      {open && createPortal(
        <MdDialog open class="plan-card__control-warning-dialog" onClose={close}>
          <div slot="headline" class="plan-card__control-warning-headline">
            <span class="plan-card__control-warning-title">{recommendation.title}</span>
            <MdIconButton type="button" class="plan-card__control-warning-close" aria-label="Close" onClick={close}>
              <CloseIcon />
            </MdIconButton>
          </div>
          <div slot="content">
            <p class="plan-card__control-warning-body">{recommendation.body}</p>
            <p class="pels-card-supporting plan-card__control-warning-hint">
              Hide warning removes this icon until it happens again.
            </p>
          </div>
          <div slot="actions">
            <MdTextButton type="button" disabled={busy || !onDismiss || undefined} onClick={hide}>
              {busy ? 'Hiding…' : 'Hide warning'}
            </MdTextButton>
            <MdTextButton type="button" onClick={openDevice}>Open device</MdTextButton>
          </div>
        </MdDialog>,
        document.body,
      )}
    </span>
  );
};
