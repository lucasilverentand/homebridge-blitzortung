import { EventEmitter } from 'node:events';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import type { ResolvedConfig } from './config.js';
import { distanceKm, mqttTopicsForRadius } from './geo.js';

export interface NearbyStrike {
  latitude: number;
  longitude: number;
  distanceKm: number;
  receivedAt: Date;
}

export interface BlitzortungClientEvents {
  connected: [];
  disconnected: [];
  error: [Error];
  strike: [NearbyStrike];
}

type MqttFactory = (url: string, options: IClientOptions) => MqttClient;

export class BlitzortungClient extends EventEmitter<BlitzortungClientEvents> {
  private client?: MqttClient;
  private readonly topics: string[];

  constructor(
    private readonly config: ResolvedConfig,
    private readonly connectMqtt: MqttFactory = mqtt.connect,
  ) {
    super();
    this.topics = mqttTopicsForRadius(
      config.latitude,
      config.longitude,
      config.radiusKm,
      config.topicPrefix,
    );
  }

  public connect(): void {
    if (this.client) {
      return;
    }

    const protocol = this.config.mqttTls ? 'mqtts' : 'mqtt';
    const url = `${protocol}://${this.config.mqttHost}:${this.config.mqttPort}`;
    this.client = this.connectMqtt(url, {
      username: this.config.mqttUsername,
      password: this.config.mqttPassword,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      clean: true,
    });

    this.client.on('connect', () => {
      this.client?.subscribe(this.topics, { qos: 0 }, error => {
        if (error) {
          this.emit('error', error);
          return;
        }
        this.emit('connected');
      });
    });
    this.client.on('close', () => this.emit('disconnected'));
    this.client.on('offline', () => this.emit('disconnected'));
    this.client.on('error', error => this.emit('error', error));
    this.client.on('message', (_topic, payload) => this.handleMessage(payload));
  }

  public async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) {
      return;
    }
    await client.endAsync();
  }

  public subscriptions(): readonly string[] {
    return this.topics;
  }

  private handleMessage(payload: Buffer): void {
    try {
      const value: unknown = JSON.parse(payload.toString('utf8'));
      if (!value || typeof value !== 'object') {
        return;
      }
      const record = value as Record<string, unknown>;
      const latitude = record.lat;
      const longitude = record.lon;
      if (typeof latitude !== 'number' || typeof longitude !== 'number'
        || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return;
      }
      const distance = distanceKm(
        this.config.latitude,
        this.config.longitude,
        latitude,
        longitude,
      );
      if (distance > this.config.radiusKm) {
        return;
      }
      this.emit('strike', {
        latitude,
        longitude,
        distanceKm: distance,
        receivedAt: new Date(),
      });
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }
}
