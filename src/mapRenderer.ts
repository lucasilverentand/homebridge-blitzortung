import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp, { type OverlayOptions } from 'sharp';

import type { NearbyStrike } from './blitzortungClient.js';
import type { ResolvedConfig } from './config.js';

const TILE_SIZE = 256;
const MAX_MERCATOR_LATITUDE = 85.05112878;

interface PixelCoordinate {
  x: number;
  y: number;
}

interface CachedFrame {
  renderedAt: number;
  revision: number;
  buffer: Buffer;
}

type TileFetcher = (url: string, userAgent: string) => Promise<Buffer>;

export interface MapRendererOptions {
  config: ResolvedConfig;
  cacheDirectory: string;
  fetchTile?: TileFetcher;
  warn?: (message: string) => void;
}

async function defaultTileFetcher(url: string, userAgent: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
    },
  });
  if (!response.ok) {
    throw new Error(`tile request failed with HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function coordinateToWorldPixel(latitude: number, longitude: number, zoom: number): PixelCoordinate {
  const clampedLatitude = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
  const scale = TILE_SIZE * 2 ** zoom;
  const sine = Math.sin(clampedLatitude * Math.PI / 180);
  return {
    x: (longitude + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale,
  };
}

export function radiusPixels(latitude: number, radiusKm: number, zoom: number): number {
  const metresPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / 2 ** zoom;
  return radiusKm * 1000 / metresPerPixel;
}

export class LightningMapRenderer {
  private readonly strikes: NearbyStrike[] = [];
  private readonly frameCache = new Map<string, CachedFrame>();
  private readonly framePromises = new Map<string, Promise<Buffer>>();
  private readonly tilePromises = new Map<string, Promise<Buffer>>();
  private readonly warnedTiles = new Set<string>();
  private readonly fetchTile: TileFetcher;
  private connected = false;
  private revision = 0;

  constructor(private readonly options: MapRendererOptions) {
    this.fetchTile = options.fetchTile ?? defaultTileFetcher;
  }

  public recordStrike(strike: NearbyStrike): void {
    this.strikes.push(strike);
    this.prune(strike.receivedAt.getTime());
    this.revision += 1;
  }

  public setConnected(connected: boolean): void {
    if (this.connected === connected) {
      return;
    }
    this.connected = connected;
    this.revision += 1;
  }

  public recentStrikes(now = new Date()): readonly NearbyStrike[] {
    this.prune(now.getTime());
    return this.strikes;
  }

  public async frame(width: number, height: number, now = new Date()): Promise<Buffer> {
    const key = `${width}x${height}`;
    const cached = this.frameCache.get(key);
    const refreshMilliseconds = this.options.config.camera.refreshSeconds * 1000;
    if (cached
      && cached.revision === this.revision
      && now.getTime() - cached.renderedAt < refreshMilliseconds) {
      return cached.buffer;
    }
    const existingRender = this.framePromises.get(key);
    if (existingRender) {
      return existingRender;
    }
    const renderPromise = this.render(width, height, now).then(buffer => {
      this.frameCache.set(key, {
        renderedAt: now.getTime(),
        revision: this.revision,
        buffer,
      });
      return buffer;
    });
    this.framePromises.set(key, renderPromise);
    try {
      return await renderPromise;
    } finally {
      if (this.framePromises.get(key) === renderPromise) {
        this.framePromises.delete(key);
      }
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.options.config.camera.strikeHistoryMinutes * 60_000;
    const firstRecent = this.strikes.findIndex(strike => strike.receivedAt.getTime() >= cutoff);
    if (firstRecent === -1) {
      this.strikes.splice(0, this.strikes.length);
    } else if (firstRecent > 0) {
      this.strikes.splice(0, firstRecent);
    }
  }

  private async render(width: number, height: number, now: Date): Promise<Buffer> {
    const config = this.options.config;
    const zoom = config.camera.zoom;
    const centre = coordinateToWorldPixel(config.latitude, config.longitude, zoom);
    const worldSize = TILE_SIZE * 2 ** zoom;
    const left = centre.x - width / 2;
    const top = centre.y - height / 2;
    const minimumTileX = Math.floor(left / TILE_SIZE);
    const maximumTileX = Math.floor((left + width - 1) / TILE_SIZE);
    const minimumTileY = Math.floor(top / TILE_SIZE);
    const maximumTileY = Math.floor((top + height - 1) / TILE_SIZE);
    const mosaicWidth = (maximumTileX - minimumTileX + 1) * TILE_SIZE;
    const mosaicHeight = (maximumTileY - minimumTileY + 1) * TILE_SIZE;
    const composites: OverlayOptions[] = [];

    for (let rawY = minimumTileY; rawY <= maximumTileY; rawY += 1) {
      if (rawY < 0 || rawY >= 2 ** zoom) {
        continue;
      }
      for (let rawX = minimumTileX; rawX <= maximumTileX; rawX += 1) {
        const tileX = ((rawX % 2 ** zoom) + 2 ** zoom) % 2 ** zoom;
        try {
          const input = await this.tile(zoom, tileX, rawY);
          composites.push({
            input,
            left: (rawX - minimumTileX) * TILE_SIZE,
            top: (rawY - minimumTileY) * TILE_SIZE,
          });
        } catch (error) {
          const warningKey = `${zoom}/${tileX}/${rawY}`;
          if (!this.warnedTiles.has(warningKey)) {
            this.warnedTiles.add(warningKey);
            this.options.warn?.(`Map tile ${warningKey} unavailable: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }

    const mosaic = await sharp({
      create: {
        width: mosaicWidth,
        height: mosaicHeight,
        channels: 3,
        background: '#17202a',
      },
    }).composite(composites).png().toBuffer();
    const cropped = await sharp(mosaic).extract({
      left: Math.max(0, Math.floor(left - minimumTileX * TILE_SIZE)),
      top: Math.max(0, Math.floor(top - minimumTileY * TILE_SIZE)),
      width,
      height,
    }).toBuffer();
    const overlay = this.overlaySvg(width, height, left, top, worldSize, now);
    return sharp(cropped)
      .composite([{ input: Buffer.from(overlay) }])
      .jpeg({ quality: 88, chromaSubsampling: '4:2:0' })
      .toBuffer();
  }

  private async tile(zoom: number, x: number, y: number): Promise<Buffer> {
    const cacheFile = path.join(this.options.cacheDirectory, String(zoom), String(x), `${y}.png`);
    const existing = this.tilePromises.get(cacheFile);
    if (existing) {
      return existing;
    }
    const request = this.loadTile(cacheFile, zoom, x, y);
    this.tilePromises.set(cacheFile, request);
    try {
      return await request;
    } finally {
      if (this.tilePromises.get(cacheFile) === request) {
        this.tilePromises.delete(cacheFile);
      }
    }
  }

  private async loadTile(cacheFile: string, zoom: number, x: number, y: number): Promise<Buffer> {
    const maximumAge = this.options.config.camera.tileCacheDays * 86_400_000;
    try {
      const metadata = await stat(cacheFile);
      if (Date.now() - metadata.mtimeMs < maximumAge) {
        return await readFile(cacheFile);
      }
    } catch {
      // A missing or unreadable entry is fetched and atomically replaced below.
    }

    const url = this.options.config.camera.tileUrlTemplate
      .replace('{z}', String(zoom))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const buffer = await this.fetchTile(url, this.options.config.camera.tileUserAgent);
    await mkdir(path.dirname(cacheFile), { recursive: true });
    const temporaryFile = `${cacheFile}.${process.pid}.tmp`;
    await writeFile(temporaryFile, buffer);
    await rename(temporaryFile, cacheFile);
    return buffer;
  }

  private overlaySvg(
    width: number,
    height: number,
    left: number,
    top: number,
    worldSize: number,
    now: Date,
  ): string {
    const config = this.options.config;
    const strikes = this.recentStrikes(now);
    const historyMilliseconds = config.camera.strikeHistoryMinutes * 60_000;
    const markers = strikes.map(strike => {
      const pixel = coordinateToWorldPixel(strike.latitude, strike.longitude, config.camera.zoom);
      let x = pixel.x - left;
      if (x < -worldSize / 2) {
        x += worldSize;
      } else if (x > worldSize / 2) {
        x -= worldSize;
      }
      const y = pixel.y - top;
      const ageRatio = Math.min(1, Math.max(0, (now.getTime() - strike.receivedAt.getTime()) / historyMilliseconds));
      const opacity = 1 - ageRatio * 0.65;
      const size = 8 - ageRatio * 3;
      return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" opacity="${opacity.toFixed(2)}">`
        + `<circle r="${(size + 3).toFixed(1)}" fill="#ff3b30" fill-opacity="0.28"/>`
        + `<path d="M 1 -${size.toFixed(1)} L -4 1 L 0 1 L -2 ${size.toFixed(1)} L 5 -2 L 1 -2 Z" fill="#ffd60a" stroke="#111827" stroke-width="1"/>`
        + '</g>';
    }).join('');
    const radius = radiusPixels(config.latitude, config.radiusKm, config.camera.zoom);
    const title = escapeXml(config.camera.name);
    const attribution = escapeXml(config.camera.tileAttribution);
    const status = this.connected ? 'Feed connected' : 'Feed unavailable';
    const statusColour = this.connected ? '#30d158' : '#ff453a';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
      + '<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}</style>'
      + `<circle cx="${width / 2}" cy="${height / 2}" r="${radius.toFixed(1)}" fill="#0a84ff" fill-opacity="0.08" stroke="#0a84ff" stroke-width="2" stroke-dasharray="7 5"/>`
      + markers
      + `<circle cx="${width / 2}" cy="${height / 2}" r="5" fill="#0a84ff" stroke="white" stroke-width="2"/>`
      + '<rect x="12" y="12" width="248" height="58" rx="12" fill="#111827" fill-opacity="0.88"/>'
      + `<text x="26" y="36" fill="white" font-size="18" font-weight="700">${title}</text>`
      + `<circle cx="31" cy="55" r="5" fill="${statusColour}"/>`
      + `<text x="43" y="60" fill="#e5e7eb" font-size="13">${status} · ${strikes.length} recent</text>`
      + `<rect x="0" y="${height - 27}" width="${width}" height="27" fill="#111827" fill-opacity="0.82"/>`
      + `<text x="12" y="${height - 9}" fill="#f3f4f6" font-size="11">Radius ${config.radiusKm} km · ${attribution}</text>`
      + '</svg>';
  }
}
