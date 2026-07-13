import { describe, expect, it, vi } from 'vitest';

import type { API, CameraControllerOptions, Logger } from 'homebridge';
import type { ResolvedConfig } from '../src/config.js';
import { LightningMapCamera } from '../src/mapCamera.js';
import type { LightningMapRenderer } from '../src/mapRenderer.js';

const config = {
  camera: {},
} as ResolvedConfig;

const log = {
  debug: vi.fn(),
  warn: vi.fn(),
} as unknown as Logger;

describe('LightningMapCamera', () => {
  it('advertises the standard HomeKit camera compatibility profile', () => {
    let options: CameraControllerOptions | undefined;
    class FakeCameraController {
      constructor(received: CameraControllerOptions) {
        options = received;
      }
    }
    const api = {
      hap: { CameraController: FakeCameraController },
    } as unknown as API;
    const renderer = { frame: vi.fn() } as unknown as LightningMapRenderer;

    new LightningMapCamera(log, api, config, renderer);

    expect(options?.cameraStreamCount).toBe(2);
    expect(options?.streamingOptions.video.resolutions).toContainEqual([320, 240, 15]);
    expect(options?.streamingOptions.video.resolutions).toContainEqual([1280, 720, 30]);
    expect(options?.streamingOptions.video.resolutions).toContainEqual([1920, 1080, 30]);
    expect(options?.streamingOptions.audio).toBeUndefined();
  });
});
