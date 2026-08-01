import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHubCoordinates } from '../../setup/homeyLocationAdapter';
import { mockHomeyInstance, setMockGeolocation } from '../mocks/homey';

const GEOLOCATION_PERMISSION = 'homey:manager:geolocation';

describe('Homey location Web API adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setMockGeolocation(59.91, 10.75);
  });

  it('resolves finite coordinates from the owner-authenticated Web API response', async () => {
    setMockGeolocation(60.39, 5.32);

    await expect(readHubCoordinates()).resolves.toEqual({
      kind: 'resolved',
      coordinates: { latitude: 60.39, longitude: 5.32 },
    });
  });

  it('classifies an absent or malformed location without fabricating coordinates', async () => {
    setMockGeolocation(null, null);
    await expect(readHubCoordinates()).resolves.toEqual({ kind: 'unavailable', outcome: 'no_location' });

    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValueOnce({ value: { latitude: '60.39' } });
    await expect(readHubCoordinates()).resolves.toEqual({ kind: 'unavailable', outcome: 'no_location' });

    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValueOnce({
      value: { latitude: 120, longitude: 250 },
    });
    await expect(readHubCoordinates()).resolves.toEqual({ kind: 'unavailable', outcome: 'no_location' });
  });

  it('classifies an API read failure separately from a missing location', async () => {
    vi.spyOn(mockHomeyInstance.api, 'get').mockRejectedValueOnce(new Error('API unavailable'));

    await expect(readHubCoordinates()).resolves.toEqual({ kind: 'unavailable', outcome: 'failed' });
  });
});

describe('geolocation manifest permission', () => {
  it('keeps both the Compose source and generated manifest on the existing manager API permission', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const compose = JSON.parse(fs.readFileSync(path.join(repoRoot, '.homeycompose/app.json'), 'utf8')) as {
      permissions?: unknown[];
    };
    const generated = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8')) as {
      permissions?: unknown[];
    };

    expect(compose.permissions).not.toContain(GEOLOCATION_PERMISSION);
    expect(generated.permissions).toEqual(compose.permissions);
  });
});
