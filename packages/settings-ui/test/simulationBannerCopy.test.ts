import { describe, expect, it } from 'vitest';
import {
  readDryRunBannerHomeScope,
  resolveDryRunBannerContent,
  resolveHasMeterAreas,
} from '../src/ui/capacity.ts';

describe('simulation banner scope', () => {
  it('preserves the single-home copy when the saved roster has no meter areas', () => {
    expect(resolveHasMeterAreas({
      status: 'resolved',
      config: undefined,
      initializedMarker: undefined,
    })).toBe(false);
    expect(resolveHasMeterAreas({
      status: 'resolved',
      config: { subHomes: [] },
      initializedMarker: true,
    })).toBe(false);
    expect(resolveDryRunBannerContent(false)).toEqual({
      text: 'Simulation on — devices stay as-is',
      actionLabel: 'Turn off simulation',
    });
  });

  it('scopes both claims to Main when a meter area exists', () => {
    expect(resolveHasMeterAreas({
      status: 'resolved',
      config: { subHomes: [{ homeId: 'h_rental' }] },
      initializedMarker: true,
    })).toBe(true);
    expect(resolveDryRunBannerContent(true)).toEqual({
      text: 'Main home simulation on — Main home devices stay as-is',
      actionLabel: 'Turn off Main simulation',
    });
  });

  it('uses the narrower truthful copy when the saved roster is missing after any present marker', () => {
    for (const initializedMarker of [true, false, 'invalid']) {
      expect(resolveHasMeterAreas({
        status: 'resolved',
        config: undefined,
        initializedMarker,
      })).toBeNull();
    }
    expect(resolveHasMeterAreas({
      status: 'resolved',
      config: { subHomes: 'invalid' },
      initializedMarker: true,
    })).toBeNull();
    expect(resolveHasMeterAreas({ status: 'unavailable' })).toBeNull();
    expect(resolveDryRunBannerContent(null)).toEqual({
      text: 'Main home simulation on — Main home devices stay as-is',
      actionLabel: 'Turn off Main simulation',
    });
  });

  it('classifies a thrown roster or marker read as unavailable', async () => {
    await expect(readDryRunBannerHomeScope(async () => {
      throw new Error('transient settings read failure');
    })).resolves.toBeNull();
  });
});
