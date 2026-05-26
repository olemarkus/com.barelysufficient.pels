import type { DebugLoggingTopic } from '../../../shared-domain/src/utils/debugLogging.ts';

const LEGACY_TOPICS_HINT_ID = 'debug-logging-legacy-hint';

export const renderLegacyTopicsHint = (
  mount: HTMLElement,
  unmatched: readonly DebugLoggingTopic[],
) => {
  document.getElementById(LEGACY_TOPICS_HINT_ID)?.remove();
  if (unmatched.length === 0) return;
  const hint = document.createElement('p');
  hint.id = LEGACY_TOPICS_HINT_ID;
  hint.className = 'muted';
  hint.textContent
    = `Keeping custom legacy topics: ${unmatched.join(', ')}. They remain enabled across saves.`;
  mount.insertAdjacentElement('afterend', hint);
};

export const removeLegacyTopicsHint = () => {
  document.getElementById(LEGACY_TOPICS_HINT_ID)?.remove();
};
