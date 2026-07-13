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
      camera: {
        enabled: false,
        name: 'Lightning Map',
        zoom: 9,
        strikeHistoryMinutes: 60,
        refreshSeconds: 10,
        tileCacheDays: 7,
      },
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

  it('validates and resolves map camera configuration', () => {
    const resolved = resolveConfig({
      ...baseConfig,
      camera: {
        enabled: true,
        zoom: 10,
        strikeHistoryMinutes: 90,
        tileUrlTemplate: 'https://maps.example.net/{z}/{x}/{y}.png',
        tileAttribution: 'Example Maps',
      },
    }, {});
    expect(resolved.camera).toMatchObject({
      enabled: true,
      zoom: 10,
      strikeHistoryMinutes: 90,
      tileAttribution: 'Example Maps',
    });
    expect(() => resolveConfig({
      ...baseConfig,
      camera: { tileUrlTemplate: 'https://maps.example.net/no-placeholders.png' },
    }, {})).toThrow('{z}');
    expect(() => resolveConfig({
      ...baseConfig,
      camera: { tileCacheDays: 1 },
    }, {})).toThrow('tileCacheDays');
  });
});
