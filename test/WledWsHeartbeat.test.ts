jest.mock('wled-client', () => require('./helpers/fakeWled').wledClientModule);

import { WledDevice } from '../src/WledDevice';
import {
  clients,
  createAccessory,
  flushPromises,
  mockLogger,
} from './helpers/fakeWled';

describe('WledDevice websocket heartbeat', () => {
  let instance: WledDevice;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    clients.length = 0;
    instance = new WledDevice(createAccessory().context.device as any, mockLogger as any, false);
    instance.connect(false);
    clients[0].emit('open');
    await flushPromises();
  });

  afterEach(() => {
    instance.disconnect();
    jest.useRealTimers();
  });

  it('keeps the connection when the ping is answered with a pong', () => {
    jest.advanceTimersByTime(30000);
    expect(clients[0].WSAPI.websocket.ping).toHaveBeenCalledTimes(1);

    clients[0].WSAPI.websocket.emit('pong');
    jest.advanceTimersByTime(10000);

    expect(clients[0].WSAPI.websocket.terminate).not.toHaveBeenCalled();
    expect(instance['connectionEstablished']).toBe(true);
  });

  it('keeps the connection when other data arrives after the ping', () => {
    jest.advanceTimersByTime(30000);
    clients[0].emit('update:effects');
    jest.advanceTimersByTime(10000);

    expect(clients[0].WSAPI.websocket.terminate).not.toHaveBeenCalled();
    expect(instance['connectionEstablished']).toBe(true);
  });

  it('reconnects when the ping is not answered', () => {
    jest.advanceTimersByTime(30000);
    expect(clients[0].WSAPI.websocket.ping).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(10000);
    expect(clients[0].WSAPI.websocket.terminate).toHaveBeenCalled();
    expect(instance['connectionEstablished']).toBe(false);

    jest.advanceTimersByTime(10000);
    expect(clients).toHaveLength(2);
  });

  it('reconnects when the ping throws', () => {
    clients[0].WSAPI.websocket.ping.mockImplementation(() => {
      throw new Error('WebSocket is not open');
    });
    jest.advanceTimersByTime(30000);

    expect(clients[0].WSAPI.websocket.terminate).toHaveBeenCalled();
    jest.advanceTimersByTime(10000);
    expect(clients).toHaveLength(2);
  });
});
