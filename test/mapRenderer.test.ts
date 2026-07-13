import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedConfig } from '../src/config.js';
import {
  coordinateToWorldPixel,
  LightningMapRenderer,
  radiusPixels,
} from '../src/mapRenderer.js';

const directories: string[] = [];

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
  camera: {
    enabled: true,
    name: 'Lightning Map',
    zoom: 9,
    strikeHistoryMinutes: 60,
    refreshSeconds: 10,
    tileUrlTemplate: 'https://tiles.example.net/{z}/{x}/{y}.png',
    tileAttribution: 'Example Maps',
    tileUserAgent: 'homebridge-blitzortung-test',
    tileCacheDays: 7,
  },
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('LightningMapRenderer', () => {
  it('projects coordinates and the configured radius into map pixels', () => {
    const centre = coordinateToWorldPixel(config.latitude, config.longitude, config.camera.zoom);
    expect(centre.x).toBeGreaterThan(0);
    expect(centre.y).toBeGreaterThan(0);
    expect(radiusPixels(config.latitude, config.radiusKm, config.camera.zoom)).toBeGreaterThan(100);
  });

  it('renders a cached JPEG map with recent strike overlays', async () => {
    const cacheDirectory = await mkdtemp(path.join(tmpdir(), 'blitzortung-map-'));
    directories.push(cacheDirectory);
    const tile = await sharp({
      create: { width: 256, height: 256, channels: 3, background: '#334155' },
    }).png().toBuffer();
    const fetchTile = vi.fn(() => Promise.resolve(tile));
    const renderer = new LightningMapRenderer({ config, cacheDirectory, fetchTile });
    renderer.setConnected(true);
    renderer.recordStrike({
      latitude: 52.37,
      longitude: 4.91,
      distanceKm: 1,
      receivedAt: new Date('2026-07-13T12:00:00Z'),
    });

    const now = new Date('2026-07-13T12:05:00Z');
    const [first, concurrent] = await Promise.all([
      renderer.frame(640, 360, now),
      renderer.frame(640, 360, now),
    ]);
    const fetchCount = fetchTile.mock.calls.length;
    const second = await renderer.frame(640, 360, now);
    const metadata = await sharp(first).metadata();

    expect(metadata).toMatchObject({ format: 'jpeg', width: 640, height: 360 });
    expect(concurrent).toEqual(first);
    expect(second).toEqual(first);
    expect(fetchCount).toBeGreaterThan(0);
    expect(fetchTile).toHaveBeenCalledTimes(fetchCount);
  });

  it('removes strikes after the configured history window', () => {
    const renderer = new LightningMapRenderer({ config, cacheDirectory: tmpdir() });
    renderer.recordStrike({
      latitude: 52.37,
      longitude: 4.91,
      distanceKm: 1,
      receivedAt: new Date('2026-07-13T10:00:00Z'),
    });
    renderer.recordStrike({
      latitude: 52.38,
      longitude: 4.92,
      distanceKm: 2,
      receivedAt: new Date('2026-07-13T11:45:00Z'),
    });
    expect(renderer.recentStrikes(new Date('2026-07-13T12:00:00Z'))).toHaveLength(1);
  });
});
