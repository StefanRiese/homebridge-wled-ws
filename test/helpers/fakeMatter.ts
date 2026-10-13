// Test double for the Homebridge Matter API (api.matter) and the API object around it.

export function createMatterApi() {
  const state: Record<string, Record<string, Record<string, unknown>>> = {};
  const registered = new Set<string>();
  const matter = {
    deviceTypes: {
      OnOffLight: { name: 'OnOffLight' },
      DimmableLight: { name: 'DimmableLight' },
      ColorTemperatureLight: { name: 'ColorTemperatureLight' },
      ExtendedColorLight: { name: 'ExtendedColorLight' },
    },
    // like Homebridge, (un)registrations are applied asynchronously after the call resolved
    registerPlatformAccessories: jest.fn(async (_plugin: string, _platform: string, accessories: any[]) => {
      setTimeout(() => {
        for (const accessory of accessories) {
          // Homebridge rejects (and only logs) a second registration of the same UUID
          if (registered.has(accessory.UUID)) {
            continue;
          }
          registered.add(accessory.UUID);
          // a restored accessory keeps its cached state
          state[accessory.UUID] = state[accessory.UUID] ?? JSON.parse(JSON.stringify(accessory.clusters ?? {}));
        }
      }, 10);
    }),
    unregisterPlatformAccessories: jest.fn(async (_plugin: string, _platform: string, accessories: any[]) => {
      setTimeout(() => {
        for (const accessory of accessories) {
          registered.delete(accessory.UUID);
          delete state[accessory.UUID];
        }
        // removing an endpoint takes longer than adding one
      }, 50);
    }),
    updatePlatformAccessories: jest.fn().mockResolvedValue(undefined),
    updateAccessoryState: jest.fn(async (uuid: string, cluster: string, attributes: Record<string, unknown>) => {
      if (!state[uuid]) {
        throw new Error(`Accessory ${uuid} not found or not registered`);
      }
      state[uuid][cluster] = { ...state[uuid][cluster], ...attributes };
    }),
    getAccessoryState: jest.fn(async (uuid: string, cluster: string) => state[uuid]?.[cluster]),
    // state as seen by Matter controllers, can be preset to simulate a cache restore
    state,
  };
  return {
    matter,
    hap: { uuid: { generate: (value: string) => `uuid-${value}` } },
    isMatterEnabled: jest.fn(() => true),
  };
}

export type FakeMatterApi = ReturnType<typeof createMatterApi>;

// returns the accessory passed to the n-th registerPlatformAccessories call
export function registeredAccessory(api: FakeMatterApi, call = 0) {
  return api.matter.registerPlatformAccessories.mock.calls[call][2][0];
}
