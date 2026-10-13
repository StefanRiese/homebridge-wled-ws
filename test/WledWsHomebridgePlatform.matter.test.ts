jest.mock('wled-client', () => require('./helpers/fakeWled').wledClientModule);

import { WledWsHomebridgePlatform } from '../src/WledWsHomebridgePlatform';
import { createService, mockLogger } from './helpers/fakeWled';
import { createMatterApi } from './helpers/fakeMatter';

const controllers = [
  { name: 'Controller1', address: '192.168.1.1' },
  { name: 'Controller2', address: '192.168.1.2' },
];

function createApi(withMatter: boolean) {
  const matterApi = createMatterApi();
  const api: Record<string, unknown> = {
    hap: {
      Service: { Lightbulb: {}, Switch: {}, AccessoryInformation: {} },
      Characteristic: {},
      HapStatusError: Error,
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
      uuid: matterApi.hap.uuid,
    },
    // events are triggered by the tests
    on: jest.fn(),
    registerPlatformAccessories: jest.fn(),
    unregisterPlatformAccessories: jest.fn(),
    updatePlatformAccessories: jest.fn(),
    platformAccessory: jest.fn(function (name: string, uuid: string) {
      const service = createService();
      return {
        displayName: name,
        UUID: uuid,
        context: {},
        getService: jest.fn().mockReturnValue(service),
        addService: jest.fn().mockReturnValue(service),
        getServiceById: jest.fn(),
        removeService: jest.fn(),
      };
    }),
  };
  if (withMatter) {
    // Homebridge 2.x with Matter enabled on the bridge; Homebridge 1.x has neither
    api.matter = matterApi.matter;
    api.isMatterEnabled = matterApi.isMatterEnabled;
  }
  return { api, matter: matterApi.matter };
}

const cachedMatterAccessory = (address: string) => ({
  UUID: `uuid-matter:${address}`,
  displayName: address,
  context: { address, lightCapability: 1 },
});

describe('WledWsHomebridgePlatform Matter support', () => {
  let platform: WledWsHomebridgePlatform;

  const start = (api: Record<string, unknown>, enableMatter: boolean, cached: unknown[] = []) => {
    platform = new WledWsHomebridgePlatform(
      mockLogger as any,
      { name: 'Test', controllers, enableMatter } as any,
      api as any,
    );
    for (const accessory of cached) {
      platform.configureMatterAccessory(accessory as any);
    }
    platform.discoverDevices();
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    platform.disconnectDevices();
  });

  it('runs without Matter on Homebridge 1.x', () => {
    const { api } = createApi(false);
    start(api, true);

    expect(platform.matterEnabled).toBe(false);
    expect(platform['matterAccessoryMap'].size).toBe(0);
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(2);
  });

  it('does not use Matter unless enabled in the plugin config', () => {
    const { api } = createApi(true);
    start(api, false);

    expect(platform.matterEnabled).toBe(false);
    expect(platform['matterAccessoryMap'].size).toBe(0);
  });

  it('does not use Matter if the bridge does not run Matter', () => {
    const { api } = createApi(true);
    (api.isMatterEnabled as jest.Mock).mockReturnValue(false);
    start(api, true);

    expect(platform.matterEnabled).toBe(false);
  });

  it('creates a Matter accessory per controller', () => {
    const { api } = createApi(true);
    start(api, true);

    expect(platform.matterEnabled).toBe(true);
    expect([...platform['matterAccessoryMap'].keys()]).toEqual(['192.168.1.1', '192.168.1.2']);
  });

  it('passes the cached Matter accessory to the accessory of its controller', () => {
    const { api, matter } = createApi(true);
    start(api, true, [cachedMatterAccessory('192.168.1.1')]);

    expect(platform['matterAccessoryMap'].get('192.168.1.1')!.uuid).toBe('uuid-matter:192.168.1.1');
    expect(matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
  });

  it('removes cached Matter accessories of controllers no longer configured', () => {
    const { api, matter } = createApi(true);
    const orphan = cachedMatterAccessory('192.168.1.99');
    start(api, true, [cachedMatterAccessory('192.168.1.1'), orphan]);

    expect(matter.unregisterPlatformAccessories).toHaveBeenCalledWith(
      'homebridge-wled-ws', 'wled-ws', [orphan],
    );
  });

  it('removes duplicate cached Matter accessories of a controller', () => {
    const { api, matter } = createApi(true);
    const first = cachedMatterAccessory('192.168.1.1');
    // e.g. left over from an older plugin version with another UUID scheme
    const duplicate = { ...cachedMatterAccessory('192.168.1.1'), UUID: 'uuid-matter:192.168.1.1:7' };
    start(api, true, [first, duplicate]);

    expect(matter.unregisterPlatformAccessories).toHaveBeenCalledWith(
      'homebridge-wled-ws', 'wled-ws', [duplicate],
    );
  });

  it('removes all cached Matter accessories when Matter was disabled in the config', () => {
    const { api, matter } = createApi(true);
    const cached = [cachedMatterAccessory('192.168.1.1'), cachedMatterAccessory('192.168.1.2')];
    start(api, false, cached);

    expect(matter.unregisterPlatformAccessories).toHaveBeenCalledWith(
      'homebridge-wled-ws', 'wled-ws', cached,
    );
  });
});
