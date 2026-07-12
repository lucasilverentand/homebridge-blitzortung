import { describe, expect, it } from 'vitest';

import { distanceKm, geohashesForRadius, mqttTopicsForRadius } from '../src/geo.js';

describe('geo helpers', () => {
  it('calculates great-circle distance', () => {
    expect(distanceKm(52.3676, 4.9041, 52.0907, 5.1214)).toBeCloseTo(34.16, 1);
  });

  it('limits the geohash subscription set', () => {
    const hashes = geohashesForRadius(52.3676, 4.9041, 25);
    expect(hashes.length).toBeGreaterThan(0);
    expect(hashes.length).toBeLessThanOrEqual(9);
  });

  it('formats geohashes as hierarchical MQTT subscriptions', () => {
    const topics = mqttTopicsForRadius(52.3676, 4.9041, 25, 'blitzortung/1.1');
    expect(topics.every(topic => topic.startsWith('blitzortung/1.1/'))).toBe(true);
    expect(topics.every(topic => topic.endsWith('/#'))).toBe(true);
  });
});
