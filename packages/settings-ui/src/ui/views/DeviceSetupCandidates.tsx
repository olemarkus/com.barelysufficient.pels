import { useState } from 'preact/hooks';
import { MdFilledTextField, MdTextButton } from './materialWebJSX.tsx';

type SetupCandidate = { id: string; name: string; suggested: boolean };

export const DeviceSetupCandidates = ({ devices, onOpen }: {
  devices: readonly SetupCandidate[];
  onOpen: (id: string) => void;
}) => {
  const [query, setQuery] = useState('');
  const search = query.trim().toLocaleLowerCase();
  const canSearch = devices.some(({ suggested }) => !suggested);
  const shown = search ? devices.filter(({ name }) => name.toLocaleLowerCase().includes(search))
    : devices.filter(({ suggested }) => suggested);
  return (
    <section class="pels-surface-card device-setup-candidates" aria-labelledby="device-setup-candidates-title">
      <h3 class="plan-card__title" id="device-setup-candidates-title">Needs setup</h3>
      {canSearch && !search && shown.length === 0 && (
        <p class="pels-card-supporting">Search for a device to set up.</p>
      )}
      {canSearch && (
        <MdFilledTextField label="Find another device" value={query}
          onInput={(event: Event) => setQuery((event.currentTarget as HTMLInputElement).value)} />
      )}
      {shown.map(({ id, name }) => (
        <div class="device-setup-candidates__row" key={id}>
          <span>{name}</span>
          <MdTextButton type="button" aria-label={`Set up ${name}`} onClick={() => onOpen(id)}>Set up</MdTextButton>
        </div>
      ))}
      {search && !shown.length && <p class="pels-card-supporting">No devices match that name.</p>}
    </section>
  );
};
