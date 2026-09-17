import { render } from 'preact';
import type { SetupRecommendation } from '../recommendationsModel.ts';
import { AppBar } from './AppBar.tsx';
import { MdFilledTonalButton, MdTextButton } from './materialWebJSX.tsx';

export type SetupRecommendationsViewProps = {
  active: readonly SetupRecommendation[];
  dismissed: readonly SetupRecommendation[];
  readiness: 'loading' | 'partial' | 'resolved';
  dismissalStatus: 'loading' | 'unavailable' | 'available';
  onAction: (recommendation: SetupRecommendation) => void;
  onDismiss: (recommendation: SetupRecommendation) => void;
  onRestore: (recommendation: SetupRecommendation) => void;
  onRetry: () => void;
};

type RecommendationCardProps = {
  recommendation: SetupRecommendation;
  dismissed: boolean;
  dismissalStatus: SetupRecommendationsViewProps['dismissalStatus'];
  onAction: (recommendation: SetupRecommendation) => void;
  onDismiss: (recommendation: SetupRecommendation) => void;
  onRestore: (recommendation: SetupRecommendation) => void;
};

const RecommendationCard = (props: RecommendationCardProps) => {
  const { recommendation, dismissed, onAction, onDismiss, onRestore } = props;
  return (
    <article class="pels-surface-card setup-recommendation-card" data-tone={dismissed ? 'muted' : undefined}>
      <div class="setup-recommendation-card__header">
        <h3 class="plan-card__title">{recommendation.title}</h3>
        <span class={`plan-chip ${dismissed ? 'plan-chip--muted' : 'plan-chip--info'}`}>
          {dismissed ? 'Dismissed' : 'Recommended'}
        </span>
      </div>
      <p class="pels-card-supporting">{recommendation.body}</p>
      <div class="setup-recommendation-card__actions">
        {!dismissed && (
          <MdFilledTonalButton type="button" onClick={() => onAction(recommendation)}>
            {recommendation.actionLabel}
          </MdFilledTonalButton>
        )}
        {props.dismissalStatus === 'available' && <MdTextButton
          type="button"
          onClick={() => dismissed ? onRestore(recommendation) : onDismiss(recommendation)}
        >
          {dismissed ? 'Show again' : 'Dismiss'}
        </MdTextButton>}
      </div>
    </article>
  );
};

const RecommendationsList = (props: SetupRecommendationsViewProps) => (
  <>
    {props.readiness === 'partial' && (
      <p class="muted setup-recommendations-loading">Some recommendation checks couldn’t be refreshed right now.</p>
    )}
    {props.active.length === 0
      ? (
        <section class="pels-surface-card setup-recommendations-empty">
          <strong>{props.readiness === 'partial' ? 'No suggestions from the checks that finished' : 'No setup suggestions right now'}</strong>
          <p class="pels-card-supporting">
            {props.readiness === 'partial'
              ? 'Try again later to check the remaining optional suggestions.'
              : 'PELS has no device setup changes to suggest.'}
          </p>
        </section>
      )
      : (
        <section class="setup-recommendations-list" aria-label="Recommendations to review">
          {props.active.map((recommendation) => (
            <RecommendationCard
              key={recommendation.id}
              recommendation={recommendation}
              dismissed={false}
              dismissalStatus={props.dismissalStatus}
              onAction={props.onAction}
              onDismiss={props.onDismiss}
              onRestore={props.onRestore}
            />
          ))}
        </section>
      )}
    {props.dismissed.length > 0 && (
      <details class="settings-collapse setup-recommendations-dismissed">
        <summary>
          <h3 class="section-title">Dismissed</h3>
          <span class="section-hint">{props.dismissed.length}</span>
          <svg class="disclosure-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6-1.41-1.41z" fill="currentColor" />
          </svg>
        </summary>
        <div class="collapse-content setup-recommendations-list">
          {props.dismissed.map((recommendation) => (
            <RecommendationCard
              key={recommendation.id}
              recommendation={recommendation}
              dismissed
              dismissalStatus={props.dismissalStatus}
              onAction={props.onAction}
              onDismiss={props.onDismiss}
              onRestore={props.onRestore}
            />
          ))}
        </div>
      </details>
    )}
  </>
);

export const SetupRecommendationsView = (props: SetupRecommendationsViewProps) => (
  <>
    <AppBar
      back={{ label: 'Back to Settings', target: 'settings' }}
      title="Setup & recommendations"
      lede="Suggested changes that can make PELS work better with your devices."
    />
    {props.readiness === 'loading' && (
      <p class="muted setup-recommendations-loading">Checking your configuration…</p>
    )}
    {props.dismissalStatus !== 'available' && (
      <section class="pels-surface-card setup-recommendations-empty">
        <p class="pels-card-supporting">
          {props.dismissalStatus === 'loading'
            ? 'Checking which suggestions you dismissed…'
            : 'Dismissed recommendations couldn’t be read. Some suggestions below may already be dismissed.'}
        </p>
        {props.dismissalStatus === 'unavailable' && (
          <MdTextButton type="button" onClick={props.onRetry}>Try again</MdTextButton>
        )}
      </section>
    )}
    {(props.readiness === 'partial' || props.readiness === 'resolved') && (
      <RecommendationsList {...props} />
    )}
  </>
);

export const SetupRecommendationsBanner = (props: { count: number; onOpen: () => void }) => {
  if (props.count === 0) return null;
  const title = props.count === 1 ? '1 recommendation' : `${props.count} recommendations`;
  return (
    <div class="banner setup-recommendations-banner">
      <strong class="banner__text">{title}</strong>
      <MdTextButton type="button" class="banner__action" onClick={props.onOpen}>Review</MdTextButton>
    </div>
  );
};

export const renderSetupRecommendationsView = (
  surface: HTMLElement,
  props: SetupRecommendationsViewProps,
): void => {
  render(<SetupRecommendationsView {...props} />, surface);
};

export const renderSetupRecommendationsBanner = (
  surface: HTMLElement,
  props: Parameters<typeof SetupRecommendationsBanner>[0],
): void => {
  render(<SetupRecommendationsBanner {...props} />, surface);
};
