import geohash from 'ngeohash';

const EARTH_RADIUS_KM = 6371.0088;
const MAX_SUBSCRIPTIONS = 9;

function radians(degrees: number): number {
  return degrees * Math.PI / 180;
}

export function distanceKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const deltaLatitude = radians(latitudeB - latitudeA);
  const deltaLongitude = radians(longitudeB - longitudeA);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB))
    * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

interface Bounds {
  minLatitude: number;
  minLongitude: number;
  maxLatitude: number;
  maxLongitude: number;
}

function searchBounds(latitude: number, longitude: number, radiusKm: number): Bounds[] {
  const latitudeDelta = radiusKm / 110.574;
  const longitudeScale = Math.max(Math.cos(radians(latitude)), 0.01);
  const longitudeDelta = Math.min(radiusKm / (111.320 * longitudeScale), 180);
  const minLatitude = Math.max(-90, latitude - latitudeDelta);
  const maxLatitude = Math.min(90, latitude + latitudeDelta);
  const minLongitude = longitude - longitudeDelta;
  const maxLongitude = longitude + longitudeDelta;

  if (minLongitude < -180) {
    return [
      { minLatitude, minLongitude: minLongitude + 360, maxLatitude, maxLongitude: 180 },
      { minLatitude, minLongitude: -180, maxLatitude, maxLongitude },
    ];
  }
  if (maxLongitude > 180) {
    return [
      { minLatitude, minLongitude, maxLatitude, maxLongitude: 180 },
      { minLatitude, minLongitude: -180, maxLatitude, maxLongitude: maxLongitude - 360 },
    ];
  }
  return [{ minLatitude, minLongitude, maxLatitude, maxLongitude }];
}

export function geohashesForRadius(latitude: number, longitude: number, radiusKm: number): string[] {
  const bounds = searchBounds(latitude, longitude, radiusKm);
  let selected = new Set<string>([geohash.encode(latitude, longitude, 1)]);

  for (let precision = 1; precision <= 8; precision += 1) {
    const candidates = new Set<string>();
    for (const bound of bounds) {
      for (const hash of geohash.bboxes(
        bound.minLatitude,
        bound.minLongitude,
        bound.maxLatitude,
        bound.maxLongitude,
        precision,
      )) {
        candidates.add(hash);
      }
    }
    if (candidates.size > MAX_SUBSCRIPTIONS) {
      break;
    }
    selected = candidates;
  }

  return [...selected].sort();
}

export function mqttTopicsForRadius(
  latitude: number,
  longitude: number,
  radiusKm: number,
  topicPrefix: string,
): string[] {
  return geohashesForRadius(latitude, longitude, radiusKm)
    .map(hash => `${topicPrefix}/${[...hash].join('/')}/#`);
}
