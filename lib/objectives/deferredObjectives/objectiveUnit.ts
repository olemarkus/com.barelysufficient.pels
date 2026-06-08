// Display unit for a deferred objective's current/target VALUE. A heater
// objective is measured in °C, an EV-SoC objective in %. This is the ONLY place
// the unit→label mapping lives, so consumers that read the unit-agnostic
// `currentValue`/`targetValue` pair can render the right suffix without forking
// on a kind-split field. It maps kind→label only; it never branches on a value.
// Exhaustive switch (not a ternary) so widening the diagnostic's objectiveKind to
// a third member is a COMPILE error here rather than silently defaulting to °C.
export const unitForObjectiveKind = (kind: 'temperature' | 'ev_soc'): '°C' | '%' => {
  switch (kind) {
    case 'ev_soc':
      return '%';
    case 'temperature':
      return '°C';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};
