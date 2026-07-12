import type { PlatformConfig } from 'homebridge';

export interface BlitzortungPlatformConfig extends PlatformConfig {
  platform: 'Blitzortung';
  name?: string;
  latitude: number;
  longitude: number;
  radiusKm?: number;
  strikeAlertSeconds?: number;
  stormClearMinutes?: number;
  mqttHost: string;
  mqttPort?: number;
  mqttTls?: boolean;
  mqttUsername?: string;
  mqttPasswordEnvironmentVariable?: string;
  topicPrefix?: string;
}

export interface ResolvedConfig {
  name: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  strikeAlertSeconds: number;
  stormClearMinutes: number;
  mqttHost: string;
  mqttPort: number;
  mqttTls: boolean;
  mqttUsername?: string;
  mqttPassword?: string;
  topicPrefix: string;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

export function resolveConfig(config: BlitzortungPlatformConfig, environment = process.env): ResolvedConfig {
  const mqttHost = optionalString(config.mqttHost, 'mqttHost');
  if (!mqttHost) {
    throw new Error('mqttHost is required.');
  }

  const passwordVariable = optionalString(
    config.mqttPasswordEnvironmentVariable,
    'mqttPasswordEnvironmentVariable',
  );
  const mqttPassword = passwordVariable ? environment[passwordVariable] : undefined;
  if (passwordVariable && !mqttPassword) {
    throw new Error(`Environment variable ${passwordVariable} is not set.`);
  }

  const topicPrefix = optionalString(config.topicPrefix, 'topicPrefix') ?? 'blitzortung/1.1';

  return {
    name: optionalString(config.name, 'name') ?? 'Lightning',
    latitude: finiteNumber(config.latitude, 'latitude', -90, 90),
    longitude: finiteNumber(config.longitude, 'longitude', -180, 180),
    radiusKm: finiteNumber(config.radiusKm ?? 25, 'radiusKm', 1, 500),
    strikeAlertSeconds: finiteNumber(
      config.strikeAlertSeconds ?? 30,
      'strikeAlertSeconds',
      1,
      3600,
    ),
    stormClearMinutes: finiteNumber(
      config.stormClearMinutes ?? 30,
      'stormClearMinutes',
      1,
      1440,
    ),
    mqttHost,
    mqttPort: finiteNumber(config.mqttPort ?? (config.mqttTls ? 8883 : 1883), 'mqttPort', 1, 65535),
    mqttTls: config.mqttTls ?? false,
    mqttUsername: optionalString(config.mqttUsername, 'mqttUsername'),
    mqttPassword,
    topicPrefix: topicPrefix.replace(/^\/+|\/+$/g, ''),
  };
}
