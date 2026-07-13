import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import path from 'node:path';

import { BlitzortungClient } from './blitzortungClient.js';
import { resolveConfig, type BlitzortungPlatformConfig, type ResolvedConfig } from './config.js';
import { LightningState } from './lightningState.js';
import { LightningMapCamera } from './mapCamera.js';
import { LightningMapRenderer } from './mapRenderer.js';
import { LightningAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class BlitzortungPlatform implements DynamicPlatformPlugin {
  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly config?: ResolvedConfig;
  private client?: BlitzortungClient;
  private state?: LightningState;
  private mapCamera?: LightningMapCamera;
  private mapRenderer?: LightningMapRenderer;

  constructor(
    private readonly log: Logger,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    try {
      this.config = resolveConfig(config as BlitzortungPlatformConfig);
    } catch (error) {
      this.log.error('Invalid configuration: %s', error instanceof Error ? error.message : String(error));
      return;
    }

    this.api.on('didFinishLaunching', () => this.launch());
    this.api.on('shutdown', () => this.shutdown());
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  private launch(): void {
    if (!this.config) {
      return;
    }

    const sensorUuid = this.api.hap.uuid.generate('homebridge-blitzortung:nearby-lightning');
    const accessory = this.cachedAccessories.find(candidate => candidate.UUID === sensorUuid)
      ?? new this.api.platformAccessory(this.config.name, sensorUuid);
    const newAccessories: PlatformAccessory[] = [];
    const desiredUuids = new Set([sensorUuid]);
    if (!this.cachedAccessories.some(candidate => candidate.UUID === sensorUuid)) {
      newAccessories.push(accessory);
    }

    if (this.config.camera.enabled) {
      const cameraUuid = this.api.hap.uuid.generate('homebridge-blitzortung:lightning-map-camera');
      const cameraAccessory = new this.api.platformAccessory(
        this.config.camera.name,
        cameraUuid,
        this.api.hap.Categories.IP_CAMERA,
      );
      cameraAccessory.getService(this.api.hap.Service.AccessoryInformation)
        ?.setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Blitzortung.org')
        .setCharacteristic(this.api.hap.Characteristic.Model, 'Lightning Map Camera')
        .setCharacteristic(this.api.hap.Characteristic.SerialNumber, cameraUuid)
        .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, '0.2.3');
      this.mapRenderer = new LightningMapRenderer({
        config: this.config,
        cacheDirectory: path.join(
          this.api.user.storagePath(),
          'homebridge-blitzortung',
          'map-tiles',
        ),
        warn: message => this.log.warn('%s', message),
      });
      this.mapCamera = new LightningMapCamera(this.log, this.api, this.config, this.mapRenderer);
      cameraAccessory.configureController(this.mapCamera.controller);
      this.api.publishExternalAccessories(PLUGIN_NAME, [cameraAccessory]);
      void Promise.all([
        this.mapRenderer.frame(640, 360),
        this.mapRenderer.frame(1280, 720),
      ]).catch(error => {
        this.log.warn(
          'Lightning map pre-render failed: %s',
          error instanceof Error ? error.message : String(error),
        );
      });
    }

    if (newAccessories.length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
    }
    const stale = this.cachedAccessories.filter(candidate => !desiredUuids.has(candidate.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    accessory.getService(this.api.hap.Service.AccessoryInformation)
      ?.setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Blitzortung.org')
      .setCharacteristic(this.api.hap.Characteristic.Model, 'Nearby Lightning Feed')
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, sensorUuid)
      .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, '0.2.3');

    this.state = new LightningState(
      this.config.strikeAlertSeconds * 1000,
      this.config.stormClearMinutes * 60_000,
    );
    const lightningAccessory = new LightningAccessory(
      this.log,
      accessory,
      this.state,
      this.api.hap.Service,
      this.api.hap.Characteristic,
      () => new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      ),
    );

    this.client = new BlitzortungClient(this.config);
    this.client.on('connected', () => {
      this.log.info(
        'Connected to %s:%d with %d geohash subscription(s).',
        this.config?.mqttHost,
        this.config?.mqttPort,
        this.client?.subscriptions().length ?? 0,
      );
      lightningAccessory.setConnected(true);
      this.mapRenderer?.setConnected(true);
    });
    this.client.on('disconnected', () => {
      lightningAccessory.setConnected(false);
      this.mapRenderer?.setConnected(false);
    });
    this.client.on('error', error => this.log.warn('Blitzortung feed error: %s', error.message));
    this.client.on('strike', strike => {
      this.state?.recordStrike(strike.distanceKm, strike.receivedAt);
      this.mapRenderer?.recordStrike(strike);
    });
    this.client.connect();
  }

  private shutdown(): void {
    this.state?.dispose();
    this.mapCamera?.stop();
    void this.client?.disconnect();
  }
}
