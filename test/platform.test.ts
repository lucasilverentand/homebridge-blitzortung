import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { API, Logger, PlatformAccessory } from 'homebridge';
import type { BlitzortungPlatformConfig } from '../src/config.js';

const frame = vi.fn(() => Promise.resolve(Buffer.from('jpeg')));
const connect = vi.fn();

vi.mock('../src/mapRenderer.js', () => ({
  LightningMapRenderer: class {
    public frame = frame;
    public recordStrike(): void {}
    public setConnected(): void {}
  },
}));

vi.mock('../src/mapCamera.js', () => ({
  LightningMapCamera: class {
    public readonly controller = { controllerId: () => 'camera' };
    public stop(): void {}
  },
}));

vi.mock('../src/platformAccessory.js', () => ({
  LightningAccessory: class {
    public setConnected(): void {}
  },
}));

vi.mock('../src/blitzortungClient.js', () => ({
  BlitzortungClient: class extends EventEmitter {
    public connect = connect;
    public disconnect(): Promise<void> {
      return Promise.resolve();
    }
    public subscriptions(): string[] {
      return [];
    }
  },
}));

const { BlitzortungPlatform } = await import('../src/platform.js');

class FakeService {
  public setCharacteristic(): this {
    return this;
  }

  public getCharacteristic(): {
    onGet: () => void;
    updateValue: () => void;
  } {
    return {
      onGet: () => undefined,
      updateValue: () => undefined,
    };
  }

  public updateCharacteristic(): void {}
}

class FakePlatformAccessory {
  public readonly context = {};
  public readonly service = new FakeService();
  public controller?: unknown;

  constructor(
    public readonly displayName: string,
    public readonly UUID: string,
    public readonly category?: number,
  ) {}

  public getService(): FakeService {
    return this.service;
  }

  public addService(): FakeService {
    return this.service;
  }

  public configureController(controller: unknown): void {
    this.controller = controller;
  }
}

interface MockApi {
  api: API;
  finish: () => void;
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  publishExternal: ReturnType<typeof vi.fn>;
}

function mockApi(): MockApi {
  let finish = () => undefined;
  const register = vi.fn();
  const unregister = vi.fn();
  const publishExternal = vi.fn();
  const api = {
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'didFinishLaunching') {
        finish = listener;
      }
    }),
    hap: {
      uuid: { generate: (value: string) => value },
      Categories: { IP_CAMERA: 17 },
      Service: {
        AccessoryInformation: 'AccessoryInformation',
        MotionSensor: 'MotionSensor',
        OccupancySensor: 'OccupancySensor',
      },
      Characteristic: {
        Manufacturer: 'Manufacturer',
        Model: 'Model',
        SerialNumber: 'SerialNumber',
        FirmwareRevision: 'FirmwareRevision',
        MotionDetected: 'MotionDetected',
        OccupancyDetected: {
          OCCUPANCY_DETECTED: 1,
          OCCUPANCY_NOT_DETECTED: 0,
        },
      },
      HapStatusError: class extends Error {},
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    },
    platformAccessory: FakePlatformAccessory,
    user: { storagePath: () => '/tmp' },
    registerPlatformAccessories: register,
    unregisterPlatformAccessories: unregister,
    publishExternalAccessories: publishExternal,
  };
  return {
    api: api as unknown as API,
    finish: () => finish(),
    register,
    unregister,
    publishExternal,
  };
}

const config: BlitzortungPlatformConfig = {
  platform: 'Blitzortung',
  name: 'Lightning',
  latitude: 52.3676,
  longitude: 4.9041,
  mqttHost: 'mqtt.example.net',
  camera: { enabled: true, name: 'Lightning Map' },
};

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BlitzortungPlatform camera publication', () => {
  it('publishes the camera externally and keeps only the sensors on the child bridge', async () => {
    const mocked = mockApi();
    new BlitzortungPlatform(log, config, mocked.api);

    mocked.finish();
    await Promise.resolve();

    expect(mocked.register).toHaveBeenCalledTimes(1);
    expect(mocked.register.mock.calls[0]?.[2]).toHaveLength(1);
    expect(mocked.publishExternal).toHaveBeenCalledTimes(1);
    const cameras = mocked.publishExternal.mock.calls[0]?.[1] as FakePlatformAccessory[];
    expect(cameras).toHaveLength(1);
    expect(cameras[0]).toMatchObject({ displayName: 'Lightning Map', category: 17 });
    expect(cameras[0]?.controller).toBeDefined();
    expect(frame).toHaveBeenCalledWith(640, 360);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('removes the old bridged camera during migration', () => {
    const mocked = mockApi();
    const platform = new BlitzortungPlatform(log, config, mocked.api);
    const oldCamera = new FakePlatformAccessory(
      'Lightning Map',
      'homebridge-blitzortung:lightning-map-camera',
      17,
    );
    platform.configureAccessory(oldCamera as unknown as PlatformAccessory);

    mocked.finish();

    expect(mocked.unregister).toHaveBeenCalledWith(
      'homebridge-blitzortung',
      'Blitzortung',
      [oldCamera],
    );
  });
});
