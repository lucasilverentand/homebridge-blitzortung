import { EventEmitter } from 'node:events';
import type { MqttClient } from 'mqtt';
import { describe, expect, it, vi } from 'vitest';

import { BlitzortungClient } from '../src/blitzortungClient.js';
import type { ResolvedConfig } from '../src/config.js';

class FakeMqttClient extends EventEmitter {
  public readonly subscribe = vi.fn((_topics, _options, callback: (error?: Error) => void) => callback());
  public readonly endAsync = vi.fn(() => Promise.resolve());
}

const config: ResolvedConfig = {
  name: 'Lightning',
  latitude: 52.3676,
  longitude: 4.9041,
  radiusKm: 25,
  strikeAlertSeconds: 30,
  stormClearMinutes: 30,
  mqttHost: 'mqtt.example.net',
  mqttPort: 1883,
  mqttTls: false,
  topicPrefix: 'blitzortung/1.1',
};

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
    mqttClient.emit('message', 'topic', Buffer.from('{'));
    expect(error).toHaveBeenCalledOnce();
  });
});
