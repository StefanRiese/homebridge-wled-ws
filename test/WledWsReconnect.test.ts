jest.mock('wled-client', () => require('./helpers/fakeWled').wledClientModule);

import { WledDevice } from '../src/WledDevice';
import {
  clients,
  createAccessory,
  flushPromises,
  mockLogger,
} from './helpers/fakeWled';

describe('WledDevice reconnect', () => {
  let instance: WledDevice;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    clients.length = 0;
  });

  afterEach(() => {
    instance.disconnect();
    jest.useRealTimers();
  });

  it('schedules a reconnect when only the websocket connection failed', async () => {
    // HTTP succeeded, websocket did not: init resolves without open/error/close events
    instance = new WledDevice(createAccessory().context.device as any, mockLogger as any, false);
    instance.connect(false);
    await flushPromises();
    expect(instance['connectionEstablished']).toBe(false);

    jest.advanceTimersByTime(10000);
    expect(clients).toHaveLength(2);
  });

  it('does not schedule a reconnect when the websocket is open', async () => {
    instance = new WledDevice(createAccessory().context.device as any, mockLogger as any, false);
    instance.connect(false);
    clients[0].emit('open');
    await flushPromises();

    jest.advanceTimersByTime(10000);
    expect(clients).toHaveLength(1);
  });
});
