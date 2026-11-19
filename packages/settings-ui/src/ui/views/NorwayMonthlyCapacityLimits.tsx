import { render } from 'preact';
import type { NorwayMonthlyCapacityRead, NorwayCapacityChoiceState } from '../../../../contracts/src/norwayMonthlyCapacity.ts';
import { MdElevation, MdTextButton } from './materialWebJSX.tsx';
import { MonthlyCapacityActions } from './NorwayMonthlyCapacity.tsx';

type Props = {
  read: NorwayMonthlyCapacityRead;
  choice: NorwayCapacityChoiceState;
  busy: boolean;
  message: string;
  onApply: () => void;
  onCancel: () => void;
};
export const MonthlyCapacityLimits = ({ read, choice, busy, message, onApply, onCancel }: Props) => {
  if (read.state === 'hidden') return null;
  return <section class="pels-surface-card usage-card monthly-capacity-settings" aria-labelledby="monthly-capacity-limits-title">
    <MdElevation aria-hidden="true" />
    <h3 class="plan-card__title" id="monthly-capacity-limits-title">This month’s Hard cap</h3>
    {read.state === 'ready' && <>
      {read.hardCapRecommendation.state !== 'none' && <p class="monthly-capacity-copy">
        {choice.state === 'normal' && (read.advice.state !== 'suggestion' || read.advice.actionable) && <>Recommended Hard cap: <strong>{read.hardCapRecommendation.limitKw} kW</strong>. </>}
        PELS reserves {read.hardCapRecommendation.marginKw} kW below the cap for unmanaged usage late in the hour.
      </p>}
      {read.coverage === 'partial' && <p class="pels-card-supporting">{read.advice.state === 'suggestion' && !read.advice.actionable
        ? 'Some hours are missing. A higher monthly cap cannot be applied from these estimates.'
        : 'Some hours are missing. Your billed tier could be higher.'}</p>}
    </>}
    <MonthlyCapacityActions read={read} choice={choice} busy={busy} message={message} onApply={onApply} onCancel={onCancel} />
    {choice.state === 'active' && <p class="pels-card-supporting">Editing your normal Hard cap or safety margin ends this temporary setting.</p>}
    <MdTextButton class="monthly-capacity-nav" type="button" data-settings-target="usage">View daily peaks in Usage</MdTextButton>
  </section>;
};
export const renderMonthlyCapacityLimits = (props: Props): void => {
  const mount = document.getElementById('monthly-capacity-limits-mount');
  if (!mount) return;
  mount.hidden = props.read.state === 'hidden';
  render(<MonthlyCapacityLimits {...props} />, mount);
};
