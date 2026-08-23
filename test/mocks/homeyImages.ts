/**
 * Mock of Homey's `ManagerImages`.
 *
 * The real manager is a registry: `getImage(id)` hands back an image that was
 * registered earlier or throws — it never creates one (see
 * `@types/homey/manager/images.d.ts`). Every Homey has exactly one manager, so
 * every fake Homey gets one too; a manager with an empty registry models the
 * ordinary case where an app's old images are already gone.
 *
 * Lives beside `homey.ts` rather than inside it so a fake `Homey.Device` base
 * can hold a manager without importing the module the `homey` alias points at —
 * a spec that mocks `homey` would otherwise import itself in a cycle.
 */

export type MockImage = {
  unregister: () => Promise<void>;
};

export type MockImagesManager = {
  /**
   * Ids the manager currently holds an image for. Add to it to model images an
   * earlier app boot registered; anything absent makes `getImage` throw.
   */
  registeredImageIds: Set<string>;
  /**
   * Ids unregistered through a handle, in call order — the observable effect of
   * `image.unregister()`.
   */
  unregisteredImageIds: string[];
  getImage: (imageId: string) => MockImage;
};

export const createMockImagesManager = (): MockImagesManager => {
  const manager: MockImagesManager = {
    registeredImageIds: new Set<string>(),
    unregisteredImageIds: [],
    getImage: (imageId: string): MockImage => {
      if (!manager.registeredImageIds.has(imageId)) {
        // The message shape matters: callers tell "this image is already gone"
        // from a real failure by matching on it (see
        // `isMissingRetiredPlanImageError` in drivers/pels_insights/device.ts).
        throw new Error(`Invalid Image ID: ${imageId}`);
      }
      return {
        unregister: async (): Promise<void> => {
          manager.registeredImageIds.delete(imageId);
          manager.unregisteredImageIds.push(imageId);
        },
      };
    },
  };
  return manager;
};
