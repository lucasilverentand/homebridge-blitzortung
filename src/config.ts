import type { PlatformConfig } from 'homebridge';

export interface LightningMapCameraConfig {
  enabled?: boolean;
  name?: string;
  zoom?: number;
  strikeHistoryMinutes?: number;
  refreshSeconds?: number;
  tileUrlTemplate?: string;
  tileAttribution?: string;
  tileUserAgent?: string;
  tileCacheDays?: number;
  ffmpegPath?: string;
}

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
  camera?: LightningMapCameraConfig;
}

export interface ResolvedLightningMapCameraConfig {
  enabled: boolean;
  name: string;
  zoom: number;
  strikeHistoryMinutes: number;
  refreshSeconds: number;
  tileUrlTemplate: string;
  tileAttribution: string;
  tileUserAgent: string;
  tileCacheDays: number;
  ffmpegPath?: string;
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
  camera: ResolvedLightningMapCameraConfig;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function finiteInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const number = finiteNumber(value, label, minimum, maximum);
  if (!Number.isInteger(number)) {
    throw new Error(`${label} must be an integer.`);
  }
  return number;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
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

function resolveCameraConfig(value: unknown): ResolvedLightningMapCameraConfig {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('camera must be an object.');
  }
  const camera = (value ?? {}) as LightningMapCameraConfig;
  const tileUrlTemplate = optionalString(camera.tileUrlTemplate, 'camera.tileUrlTemplate')
    ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  for (const token of ['{z}', '{x}', '{y}']) {
    if (!tileUrlTemplate.includes(token)) {
      throw new Error(`camera.tileUrlTemplate must contain ${token}.`);
    }
  }
  const sampleUrl = tileUrlTemplate
    .replace('{z}', '1')
    .replace('{x}', '1')
    .replace('{y}', '1');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sampleUrl);
  } catch {
    throw new Error('camera.tileUrlTemplate must be a valid URL template.');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('camera.tileUrlTemplate must use HTTP or HTTPS.');
  }

  return {
    enabled: optionalBoolean(camera.enabled, 'camera.enabled') ?? false,
    name: optionalString(camera.name, 'camera.name') ?? 'Lightning Map',
    zoom: finiteInteger(camera.zoom ?? 9, 'camera.zoom', 1, 18),
    strikeHistoryMinutes: finiteInteger(
      camera.strikeHistoryMinutes ?? 60,
      'camera.strikeHistoryMinutes',
      1,
      1440,
    ),
    refreshSeconds: finiteInteger(camera.refreshSeconds ?? 10, 'camera.refreshSeconds', 5, 300),
    tileUrlTemplate,
    tileAttribution: optionalString(camera.tileAttribution, 'camera.tileAttribution')
      ?? '© OpenStreetMap contributors',
    tileUserAgent: optionalString(camera.tileUserAgent, 'camera.tileUserAgent')
      ?? 'homebridge-blitzortung/0.2.1 (+https://github.com/lucasilverentand/homebridge-blitzortung)',
    tileCacheDays: finiteInteger(camera.tileCacheDays ?? 7, 'camera.tileCacheDays', 7, 365),
    ffmpegPath: optionalString(camera.ffmpegPath, 'camera.ffmpegPath'),
  };
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
    camera: resolveCameraConfig(config.camera),
  };
}
