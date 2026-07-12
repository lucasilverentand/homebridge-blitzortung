import type {
  API,
  CharacteristicValue,
  Logger,
  PlatformAccessory,
  Service,
} from 'homebridge';

import type { LightningSnapshot, LightningState } from './lightningState.js';

export class LightningAccessory {
  private readonly motionService: Service;
  private readonly occupancyService: Service;
  private connected = false;

  constructor(
    private readonly log: Logger,
    private readonly accessory: PlatformAccessory,
    private readonly state: LightningState,
    private readonly Service: API['hap']['Service'],
    private readonly Characteristic: API['hap']['Characteristic'],
    private readonly hapError: () => Error,
  ) {
    this.motionService = accessory.getService(Service.MotionSensor)
      ?? accessory.addService(Service.MotionSensor, `${accessory.displayName} Strike`, 'strike');
    this.occupancyService = accessory.getService(Service.OccupancySensor)
      ?? accessory.addService(Service.OccupancySensor, `${accessory.displayName} Storm`, 'storm');

    this.motionService.getCharacteristic(Characteristic.MotionDetected)
      .onGet(() => this.read(this.state.current().strikeActive));
    this.occupancyService.getCharacteristic(Characteristic.OccupancyDetected)
      .onGet(() => this.read(
        this.state.current().stormActive
          ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      ));

    this.state.subscribe(snapshot => this.update(snapshot));
  }

  public setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected) {
      this.update(this.state.current());
      return;
    }
    const error = this.hapError();
    this.motionService.getCharacteristic(this.Characteristic.MotionDetected).updateValue(error);
    this.occupancyService.getCharacteristic(this.Characteristic.OccupancyDetected).updateValue(error);
  }

  private read(value: CharacteristicValue): CharacteristicValue {
    if (!this.connected) {
      throw this.hapError();
    }
    return value;
  }

  private update(snapshot: LightningSnapshot): void {
    if (!this.connected) {
      return;
    }
    this.motionService.updateCharacteristic(
      this.Characteristic.MotionDetected,
      snapshot.strikeActive,
    );
    this.occupancyService.updateCharacteristic(
      this.Characteristic.OccupancyDetected,
      snapshot.stormActive
        ? this.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );
    if (snapshot.lastDistanceKm !== undefined && snapshot.strikeActive) {
      this.log.info('Lightning detected %s km away.', snapshot.lastDistanceKm.toFixed(1));
    }
  }
}
