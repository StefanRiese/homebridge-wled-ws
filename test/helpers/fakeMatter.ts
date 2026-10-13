// Test double for the Homebridge Matter API (api.matter) and the API object around it.
// Like Homebridge, (un)registrations of bridged accessories are applied asynchronously after the
// API call resolved, and a registration for a UUID which is still registered is dropped.

type State = Record<string, Record<string, unknown>>;

export interface FakeMatterOptions {
  // time until a registration is applied
  registerDelay?: number;
  // time until an unregistered accessory reports no state anymore (endpoint closed)
  closeDelay?: number;
  // additional time until the UUID is free for a new registration
  forgetDelay?: number;
}

export function createMatterApi(options: FakeMatterOptions = {}) {
  const { registerDelay = 10, closeDelay = 30, forgetDelay = 0 } = options;
  // state per UUID, and per `${uuid}#${partId}` for parts
  const state: Record<string, State> = {};
  const registered = new Set<string>();
  const dropped: string[] = [];
  const partKey = (uuid: string, partId?: string) => (partId ? `${uuid}#${partId}` : uuid);

  const matter = {
    deviceTypes: {
      OnOffLight: { name: 'OnOffLight' },
      DimmableLight: { name: 'DimmableLight' },
      ColorTemperatureLight: { name: 'ColorTemperatureLight' },
      ExtendedColorLight: { name: 'ExtendedColorLight' },
      OnOffOutlet: { name: 'OnOffOutlet' },
    },
    registerPlatformAccessories: jest.fn(async (_plugin: string, _platform: string, accessories: any[]) => {
      setTimeout(() => {
        for (const accessory of accessories) {
          if (registered.has(accessory.UUID)) {
            dropped.push(accessory.UUID);
            continue;
          }
          registered.add(accessory.UUID);
          // a restored accessory keeps its cached state
          state[accessory.UUID] = state[accessory.UUID] ?? JSON.parse(JSON.stringify(accessory.clusters ?? {}));
          for (const part of accessory.parts ?? []) {
            const key = partKey(accessory.UUID, part.id);
            state[key] = state[key] ?? JSON.parse(JSON.stringify(part.clusters ?? {}));
          }
        }
      }, registerDelay);
    }),
    unregisterPlatformAccessories: jest.fn(async (_plugin: string, _platform: string, accessories: any[]) => {
      for (const accessory of accessories) {
        if (!accessory.deviceType) {
          // Homebridge reads the device type to find the server of the accessory
          throw new TypeError("Cannot read properties of undefined (reading 'deviceType')");
        }
      }
      setTimeout(() => {
        for (const accessory of accessories) {
          for (const key of Object.keys(state)) {
            if (key === accessory.UUID || key.startsWith(`${accessory.UUID}#`)) {
              delete state[key];
            }
          }
        }
        setTimeout(() => accessories.forEach((accessory) => registered.delete(accessory.UUID)), forgetDelay);
      }, closeDelay);
    }),
    updatePlatformAccessories: jest.fn().mockResolvedValue(undefined),
    updateAccessoryState: jest.fn(
      async (uuid: string, cluster: string, attributes: Record<string, unknown>, partId?: string) => {
        const key = partKey(uuid, partId);
        if (!state[key]) {
          throw new Error(`Accessory ${uuid} not found or not registered`);
        }
        state[key][cluster] = { ...state[key][cluster], ...attributes };
      }),
    getAccessoryState: jest.fn(async (uuid: string, cluster: string, partId?: string) =>
      state[partKey(uuid, partId)]?.[cluster]),
    // state as seen by Matter controllers, can be preset to simulate a cache restore
    state,
    // UUIDs of registrations dropped because the UUID was still registered
    dropped,
  };
  return {
    matter,
    hap: { uuid: { generate: (value: string) => `uuid-${value}` } },
    isMatterEnabled: jest.fn(() => true),
  };
}

export type FakeMatterApi = ReturnType<typeof createMatterApi>;

// returns the accessory passed to the n-th registerPlatformAccessories call (negative: from the end)
export function registeredAccessory(api: FakeMatterApi, call = 0) {
  const calls = api.matter.registerPlatformAccessories.mock.calls;
  return calls[call < 0 ? calls.length + call : call][2][0];
}
