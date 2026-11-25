import { createPortal } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { OverviewDecisionItem } from '../overviewDecision.ts';
import { InformationIcon } from './icons.tsx';
import { MdDialog, MdIconButton, MdTextButton } from './materialWebJSX.tsx';

const STATE_LABELS: Record<OverviewDecisionItem['state'], string> = {
  met: 'Met',
  waiting: 'Waiting',
  not_checked: 'Not checked yet',
  unverified: 'Couldn’t verify',
  not_met: 'Not met',
  not_recorded: 'Not recorded',
  at_risk: 'At risk',
  held_back: 'Held back',
};

const stopCardActivation = (event: Event): void => event.stopPropagation();

type OverviewDecisionInfoProps = {
  title: string;
  subject?: string;
  items: readonly OverviewDecisionItem[];
};

export const OverviewDecisionInfo = ({ title, subject, items }: OverviewDecisionInfoProps) => {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement>(null);
  const close = (): void => {
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  };
  return (
    <span class="overview-decision-info" onClick={stopCardActivation}
      onKeyDown={stopCardActivation} onKeyUp={stopCardActivation} onPointerDown={stopCardActivation}>
      <MdIconButton ref={trigger} type="button" class="overview-decision-info__button"
        aria-label={subject ? `${title} (${subject})` : title}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <InformationIcon />
      </MdIconButton>
      {open && createPortal(
        <MdDialog open aria-label={title} onClose={close}>
          <div slot="headline">{title}</div>
          <div slot="content">
            <ul class="overview-decision-info__checks">
              {items.map((item) => (
                <li key={item.label} data-state={item.state}>
                  <strong>{STATE_LABELS[item.state]}</strong> · {item.label}
                  {item.detail && <p class="pels-card-supporting">{item.detail}</p>}
                </li>
              ))}
            </ul>
          </div>
          <div slot="actions">
            <MdTextButton type="button" onClick={close}>Close</MdTextButton>
          </div>
        </MdDialog>,
        document.body,
      )}
    </span>
  );
};
