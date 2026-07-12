import { describe, expect, it } from 'vitest';

import { resolveConfig, type BlitzortungPlatformConfig } from '../src/config.js';

const baseConfig: BlitzortungPlatformConfig = {
  platform: 'Blitzortung',
  latitude: 52.3676,
  longitude: 4.9041,
  mqttHost: 'mqtt.example.net',
};

describe('resolveConfig', () => {
  it('applies safe defaults', () => {
    expect(resolveConfig(baseConfig, {})).toMatchObject({
      name: 'Lightning',
      radiusKm: 25,
      strikeAlertSeconds: 30,
      stormClearMinutes: 30,
      mqttPort: 1883,
      mqttTls: false,
      topicPrefix: 'blitzortung/1.1',
    });
  });

  it('reads the MQTT password from the configured environment variable', () => {
    expect(resolveConfig({
      ...baseConfig,
      mqttPasswordEnvironmentVariable: 'BLITZORTUNG_PASSWORD',
    }, { BLITZORTUNG_PASSWORD: 'secret' }).mqttPassword).toBe('secret');
  });

  it('rejects missing credentials and invalid coordinates', () => {
    expect(() => resolveConfig({
      ...baseConfig,
      mqttPasswordEnvironmentVariable: 'BLITZORTUNG_PASSWORD',
    }, {})).toThrow('BLITZORTUNG_PASSWORD');
    expect(() => resolveConfig({ ...baseConfig, latitude: 91 }, {})).toThrow('latitude');
  });
});
