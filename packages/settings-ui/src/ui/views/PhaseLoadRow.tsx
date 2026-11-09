import type { SettingsUiPhaseLoad } from '../../../../contracts/src/settingsUi/power.ts';
import { Chip } from './components/Chip.tsx';
import type { ChipTone } from './components/chipTone.ts';

const WARN_SHARE = 0.9;

const toneFor = (amps: number, fuseAmps: number): ChipTone => {
  if (amps >= fuseAmps) return 'alert';
  return amps >= fuseAmps * WARN_SHARE ? 'warn' : 'muted';
};

/** Each phase's load against the main fuse. Renders nothing without trusted phases. */
export const PhaseLoadRow = ({ load }: { load: SettingsUiPhaseLoad }) => {
  if (load.state !== 'phases') return null;
  return (
    <div class="plan-phase-load" id="plan-phase-load" role="group" aria-label={`Load per phase, ${load.fuseAmps} A fuse`}>
      {load.phases.map(({ phase, amps, exporting }) => (
        <Chip key={phase} tone={toneFor(amps, load.fuseAmps)}>
          {`${phase} ${Math.round(amps)} of ${load.fuseAmps} A${exporting === true ? ' export' : ''}`}
        </Chip>
      ))}
    </div>
  );
};
