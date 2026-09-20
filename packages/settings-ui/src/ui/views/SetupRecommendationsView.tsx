import { render } from 'preact';
import type { SetupRecommendation } from '../recommendationsModel.ts';
import { AppBar } from './AppBar.tsx';
import { MdFilledTonalButton, MdTextButton } from './materialWebJSX.tsx';
import { SetupPathCard } from './SetupPathCard.tsx';
import type { SetupPath } from '../setupPathModel.ts';

export type SetupRecommendationsViewProps = {
  active: readonly SetupRecommendation[];
  dismissed: readonly SetupRecommendation[];
  // The first-run setup path while it is still open; null once setup is
  // complete or while its facts are loading.
  setupPath: SetupPath | null;
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

// An optional feature is not "recommended": nothing is wrong with a home that
// never uses it, and the chip must not say otherwise.
const CATEGORY_CHIP: Record<SetupRecommendation['category'], string> = {
  recommendation: 'Recommended',
  optional: 'Optional',
};

const RecommendationCard = (props: RecommendationCardProps) => {
  const { recommendation, dismissed, onAction, onDismiss, onRestore } = props;
  return (
    <article class="pels-surface-card setup-recommendation-card" data-tone={dismissed ? 'muted' : undefined}>
      <div class="setup-recommendation-card__header">
        <h3 class="plan-card__title">{recommendation.title}</h3>
        <span class={`plan-chip ${dismissed ? 'plan-chip--muted' : 'plan-chip--info'}`}>
          {dismissed ? 'Dismissed' : CATEGORY_CHIP[recommendation.category]}
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
    {/* While the setup path is open it IS the page's content; "no suggestions"
        beside an unfinished setup would read as "nothing to do". */}
    {props.active.length === 0 && props.setupPath === null && (
      <section class="pels-surface-card setup-recommendations-empty">
        <strong>{props.readiness === 'partial' ? 'No suggestions from the checks that finished' : 'No setup suggestions right now'}</strong>
        <p class="pels-card-supporting">
          {props.readiness === 'partial'
            ? 'Try again later to check the remaining optional suggestions.'
            : 'PELS has no device setup changes to suggest.'}
        </p>
      </section>
    )}
    {props.active.length > 0 && (
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
      lede="The steps to get PELS running, and changes that can make it work better with your devices."
    />
    {props.setupPath !== null && <SetupPathCard path={props.setupPath} surface="setup" />}
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

// "N recommendations" means PELS would change something about this home's
// setup. Optional features are not that: with only those active, the banner says
// there is more on offer and lets the owner decide whether to look.
const resolveBannerCopy = (active: readonly SetupRecommendation[]): { title: string; action: string } => {
  if (active.every((recommendation) => recommendation.category === 'optional')) {
    return { title: 'PELS can do more for this home', action: 'See what' };
  }
  return {
    title: active.length === 1 ? '1 recommendation' : `${active.length} recommendations`,
    action: 'Review',
  };
};

export const SetupRecommendationsBanner = (
  props: { active: readonly SetupRecommendation[]; onOpen: () => void },
) => {
  if (props.active.length === 0) return null;
  const copy = resolveBannerCopy(props.active);
  return (
    <div class="banner setup-recommendations-banner">
      <strong class="banner__text">{copy.title}</strong>
      <MdTextButton type="button" class="banner__action" onClick={props.onOpen}>{copy.action}</MdTextButton>
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
