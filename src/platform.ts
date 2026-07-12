import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { BlitzortungClient } from './blitzortungClient.js';
import { resolveConfig, type BlitzortungPlatformConfig, type ResolvedConfig } from './config.js';
import { LightningState } from './lightningState.js';
import { LightningAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class BlitzortungPlatform implements DynamicPlatformPlugin {
  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly config?: ResolvedConfig;
  private client?: BlitzortungClient;
  private state?: LightningState;

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

    const uuid = this.api.hap.uuid.generate('homebridge-blitzortung:nearby-lightning');
    const accessory = this.cachedAccessories.find(candidate => candidate.UUID === uuid)
      ?? new this.api.platformAccessory(this.config.name, uuid);

    if (!this.cachedAccessories.some(candidate => candidate.UUID === uuid)) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    const stale = this.cachedAccessories.filter(candidate => candidate.UUID !== uuid);
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    accessory.getService(this.api.hap.Service.AccessoryInformation)
      ?.setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Blitzortung.org')
      .setCharacteristic(this.api.hap.Characteristic.Model, 'Nearby Lightning Feed')
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, uuid)
      .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, '0.1.0');

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
    });
    this.client.on('disconnected', () => lightningAccessory.setConnected(false));
    this.client.on('error', error => this.log.warn('Blitzortung feed error: %s', error.message));
    this.client.on('strike', strike => this.state?.recordStrike(strike.distanceKm, strike.receivedAt));
    this.client.connect();
  }

  private shutdown(): void {
    this.state?.dispose();
    void this.client?.disconnect();
  }
}
