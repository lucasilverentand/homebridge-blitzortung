import { EventEmitter } from 'node:events';
import type { MqttClient } from 'mqtt';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BlitzortungClient, type NearbyStrike } from '../src/blitzortungClient.js';
import { resolveConfig } from '../src/config.js';

class FakeMqttClient extends EventEmitter {
  public readonly subscribe = vi.fn((_topics, _options, callback: (error?: Error) => void) => callback());
  public readonly endAsync = vi.fn(() => Promise.resolve());
}

const config = resolveConfig({
  platform: 'Blitzortung',
  latitude: 52.3676,
  longitude: 4.9041,
  mqttHost: 'mqtt.example.net',
});

const coordinates = { lat: 52.37, lon: 4.91 };
const timestamp = (milliseconds = Date.now()) => (BigInt(milliseconds) * 1_000_000n).toString();

function setup() {
  const broker = new FakeMqttClient();
  const client = new BlitzortungClient(config, () => broker as unknown as MqttClient);
  const strike = vi.fn<(strike: NearbyStrike) => void>();
  const connected = vi.fn();
  const error = vi.fn();
  client.on('strike', strike);
  client.on('connected', connected);
  client.on('error', error);
  client.connect();
  broker.emit('connect');
  const send = (data: object, retain = false) => broker.emit(
    'message', 'topic', Buffer.from(JSON.stringify({ ...coordinates, ...data })), { retain },
  );
  return { broker, client, strike, connected, error, send };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BlitzortungClient', () => {
  it('subscribes once and emits only in-radius strikes', () => {
    const mqttClient = new FakeMqttClient();
    const connect = vi.fn(() => mqttClient as unknown as MqttClient);
    const client = new BlitzortungClient(config, connect);
    const strike = vi.fn();
    client.on('strike', strike);

    client.connect();
    client.connect();
    mqttClient.emit('connect');

    expect(connect).toHaveBeenCalledOnce();
    expect(mqttClient.subscribe).toHaveBeenCalledOnce();

    mqttClient.emit('message', 'topic', Buffer.from(JSON.stringify({ lat: 52.37, lon: 4.91 })));
    mqttClient.emit('message', 'topic', Buffer.from(JSON.stringify({ lat: 50, lon: 4.91 })));
    expect(strike).toHaveBeenCalledOnce();
  });

  it('surfaces invalid JSON as a feed error', () => {
    const mqttClient = new FakeMqttClient();
    const client = new BlitzortungClient(config, () => mqttClient as unknown as MqttClient);
    const error = vi.fn();
    client.on('error', error);
    client.connect();
    mqttClient.emit('connect');
    mqttClient.emit('message', 'topic', Buffer.from('{'));
    expect(error).toHaveBeenCalledOnce();
  });

  it('uses a relay-friendly reconnect period', () => {
    const mqttClient = new FakeMqttClient();
    const connect = vi.fn(() => mqttClient as unknown as MqttClient);
    const client = new BlitzortungClient(config, connect);

    client.connect();

    expect(connect).toHaveBeenCalledWith('mqtt://mqtt.example.net:1883', expect.objectContaining({
      reconnectPeriod: 60_000,
      reconnectOnConnackError: true,
      resubscribe: false,
    }));
  });

  it('rejects retained, stale, future, malformed and invalid-coordinate strikes', () => {
    vi.useFakeTimers();
    const { send, strike } = setup();
    send({ time: timestamp() }, true);
    send({ time: timestamp(Date.now() - 120_001) });
    send({ time: timestamp(Date.now() + 10_001) });
    send({ time: Date.now() }); // Milliseconds are not the relay's nanosecond contract.
    send({ time: 'not-a-timestamp' });
    send({ time: null });
    send({ lat: 412.37 });
    expect(strike).not.toHaveBeenCalled();
    const sourceTime = Date.now() - 1000;
    send({ time: timestamp(sourceTime) });
    expect(strike).toHaveBeenCalledOnce();
    expect(strike.mock.calls[0]?.[0].occurredAt.getTime()).toBe(sourceTime);
    expect(strike.mock.calls[0]?.[0].receivedAt.getTime()).toBeGreaterThanOrEqual(sourceTime);
  });

  it('suppresses timestamp and stable-ID replays across transport reconnects', () => {
    const { broker, send, strike } = setup();
    const time = timestamp();
    send({ time });
    send({ time });
    send({ id: 'strike-1', time: Number(time) });
    send({ id: 'strike-1', time: timestamp(Date.now() + 1) });
    broker.emit('close');
    broker.emit('connect');
    send({ time });
    send({ id: 'strike-1' });
    expect(strike).toHaveBeenCalledTimes(2);
    // Distinct nanosecond timestamps at the same coordinates remain distinct events.
    send({ time: (BigInt(time) + 1n).toString() });
    expect(strike).toHaveBeenCalledTimes(3);
  });

  it('accepts coordinate-only relays without inventing source time or identity', () => {
    const { send, strike } = setup();
    send({});
    send({});
    expect(strike).toHaveBeenCalledTimes(2);
    expect(strike.mock.calls[0]?.[0].occurredAt).toBeUndefined();
  });

  it('expires ID-only replay protection after its documented bounded window', () => {
    vi.useFakeTimers();
    const { send, strike } = setup();
    send({ id: 'event' });
    send({ id: 'event' });
    expect(strike).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(130_000);
    send({ id: 'event' });
    expect(strike).toHaveBeenCalledTimes(2);
  });

  it('retries denied subscriptions with bounded backoff and restores delivery', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { broker, client, strike, send, error, connected } = setup();
    broker.subscribe.mockImplementation((_topics, _options, callback) => callback(new Error('denied')));
    broker.emit('close');
    broker.emit('connect');
    send({ time: timestamp() });
    expect(strike).not.toHaveBeenCalled();
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      const calls = broker.subscribe.mock.calls.length;
      vi.advanceTimersByTime(delay - 1);
      expect(broker.subscribe).toHaveBeenCalledTimes(calls);
      vi.advanceTimersByTime(1);
      expect(broker.subscribe).toHaveBeenCalledTimes(calls + 1);
    }
    expect(error).toHaveBeenCalledTimes(6);
    broker.subscribe.mockImplementation((_topics, _options, callback) => callback());
    vi.advanceTimersByTime(300_000);
    expect(connected).toHaveBeenCalledTimes(2);
    send({ time: timestamp() });
    expect(strike).toHaveBeenCalledOnce();
    await client.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels retry timers on transport loss and shutdown', async () => {
    vi.useFakeTimers();
    const { broker, client } = setup();
    broker.subscribe.mockImplementation((_topics, _options, callback) => callback(new Error('denied')));
    broker.emit('connect');
    broker.emit('offline');
    const calls = broker.subscribe.mock.calls.length;
    vi.advanceTimersByTime(600_000);
    expect(broker.subscribe).toHaveBeenCalledTimes(calls);
    broker.emit('connect');
    await client.disconnect();
    const finalCalls = broker.subscribe.mock.calls.length;
    vi.advanceTimersByTime(600_000);
    expect(broker.subscribe).toHaveBeenCalledTimes(finalCalls);
    expect(broker.endAsync).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores acknowledgements from old connections and all events after shutdown', async () => {
    const { broker, client, connected, strike, error, send } = setup();
    let acknowledge: (error?: Error) => void = () => undefined;
    broker.subscribe.mockImplementation((_topics, _options, callback) => { acknowledge = callback; });
    broker.emit('close');
    broker.emit('connect');
    const oldAcknowledgement = acknowledge;
    broker.emit('close');
    broker.emit('connect');
    oldAcknowledgement();
    expect(connected).toHaveBeenCalledOnce();
    await client.disconnect();
    acknowledge();
    broker.emit('connect');
    broker.emit('error', new Error('late error'));
    send({ time: timestamp() });
    expect(connected).toHaveBeenCalledOnce();
    expect(strike).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
