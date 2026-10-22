import { EventEmitter } from 'node:events';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import type { ResolvedConfig } from './config.js';
import { distanceKm, mqttTopicsForRadius } from './geo.js';

export interface NearbyStrike {
  latitude: number;
  longitude: number;
  distanceKm: number;
  receivedAt: Date;
  occurredAt?: Date;
}

export interface BlitzortungClientEvents {
  connected: [];
  disconnected: [];
  error: [Error];
  strike: [NearbyStrike];
}

type MqttFactory = (url: string, options: IClientOptions) => MqttClient;

const RECONNECT_PERIOD_MS = 60_000;
const MAX_SUBSCRIPTION_RETRY_MS = 300_000;
const MAX_STRIKE_AGE_MS = 120_000;
const MAX_FUTURE_SKEW_MS = 10_000;
const MAX_RECENT_IDENTITIES = 10_000;

export class BlitzortungClient extends EventEmitter<BlitzortungClientEvents> {
  private client?: MqttClient;
  private readonly topics: string[];
  private generation = 0;
  private connectionEpoch = 0;
  private transportConnected = false;
  private subscribed = false;
  private retryAttempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly recentIdentities = new Map<string, number>();

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
    const generation = ++this.generation;
    const client = this.connectMqtt(url, {
      username: this.config.mqttUsername,
      password: this.config.mqttPassword,
      reconnectPeriod: RECONNECT_PERIOD_MS,
      connectTimeout: 10_000,
      clean: true,
      resubscribe: false,
      reconnectOnConnackError: true,
    });
    this.client = client;
    const current = () => this.client === client && this.generation === generation;

    client.on('connect', () => {
      if (!current()) {
        return;
      }
      this.transportConnected = true;
      this.subscribed = false;
      const epoch = ++this.connectionEpoch;
      this.retryAttempt = 0;
      this.clearRetry();
      this.subscribe(client, generation, epoch);
    });
    const disconnected = () => {
      if (!current()) {
        return;
      }
      this.transportConnected = false;
      this.connectionEpoch += 1;
      this.subscribed = false;
      this.clearRetry();
      this.emit('disconnected');
    };
    client.on('close', disconnected);
    client.on('offline', disconnected);
    client.on('error', error => {
      if (current()) {
        this.emit('error', error);
      }
    });
    client.on('message', (_topic, payload, packet) => {
      if (current() && this.transportConnected && this.subscribed && !packet?.retain) {
        this.handleMessage(payload);
      }
    });
  }

  public async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.generation += 1;
    this.connectionEpoch += 1;
    this.transportConnected = false;
    this.subscribed = false;
    this.clearRetry();
    if (!client) {
      return;
    }
    this.emit('disconnected');
    await client.endAsync(true);
  }

  public subscriptions(): readonly string[] {
    return this.topics;
  }

  private clearRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private subscribe(client: MqttClient, generation: number, epoch: number): void {
    const current = () => this.client === client
      && this.generation === generation && this.connectionEpoch === epoch && this.transportConnected;
    if (!current()) {
      return;
    }
    client.subscribe(this.topics, { qos: 0 }, error => {
      if (!current()) {
        return;
      }
      if (error) {
        this.subscribed = false;
        this.emit('disconnected');
        this.emit('error', error);
        const backoff = Math.min(
          RECONNECT_PERIOD_MS * 2 ** Math.min(this.retryAttempt++, 3),
          MAX_SUBSCRIPTION_RETRY_MS,
        );
        const delay = Math.min(backoff * (1 + Math.random() * 0.2), MAX_SUBSCRIPTION_RETRY_MS);
        this.clearRetry();
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.subscribe(client, generation, epoch);
        }, delay);
        return;
      }
      this.retryAttempt = 0;
      this.subscribed = true;
      this.clearRetry();
      this.emit('connected');
    });
  }

  private handleMessage(payload: Buffer): void {
    try {
      const value: unknown = JSON.parse(payload.toString('utf8'));
      if (!value || typeof value !== 'object') {
        return;
      }
      const record = value as Record<string, unknown>;
      const now = Date.now();
      let occurredAt: Date | undefined;
      let sourceTime: string | undefined;
      if (record.time !== undefined) {
        // The community geohash relay uses Unix nanoseconds, not milliseconds.
        if (typeof record.time === 'number' && Number.isInteger(record.time) && record.time > 0) {
          sourceTime = BigInt(Math.trunc(record.time)).toString();
        } else if (typeof record.time === 'string' && /^\d{1,21}$/.test(record.time)) {
          sourceTime = BigInt(record.time).toString();
        } else {
          return;
        }
        const sourceMilliseconds = Number(BigInt(sourceTime) / 1_000_000n);
        if (!Number.isSafeInteger(sourceMilliseconds)
          || now - sourceMilliseconds > MAX_STRIKE_AGE_MS
          || sourceMilliseconds - now > MAX_FUTURE_SKEW_MS) {
          return;
        }
        occurredAt = new Date(sourceMilliseconds);
      }
      const latitude = record.lat;
      const longitude = record.lon;
      if (typeof latitude !== 'number' || typeof longitude !== 'number'
        || !Number.isFinite(latitude) || !Number.isFinite(longitude)
        || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
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
      let identity: string | undefined;
      if (record.id !== undefined) {
        if ((typeof record.id !== 'string' && typeof record.id !== 'number')
          || (typeof record.id === 'number' && !Number.isSafeInteger(record.id))
          || String(record.id).length === 0 || String(record.id).length > 256) {
          return;
        }
        identity = `id:${record.id}`;
      } else if (sourceTime) {
        identity = `time:${sourceTime}:${latitude}:${longitude}`;
      }
      for (const [key, expiresAt] of this.recentIdentities) {
        if (expiresAt <= now) {
          this.recentIdentities.delete(key);
        }
      }
      if (identity) {
        if (this.recentIdentities.has(identity)) {
          return;
        }
        if (this.recentIdentities.size >= MAX_RECENT_IDENTITIES) {
          const oldest = this.recentIdentities.keys().next().value;
          if (oldest !== undefined) {
            this.recentIdentities.delete(oldest);
          }
        }
        this.recentIdentities.set(identity, now + MAX_STRIKE_AGE_MS + MAX_FUTURE_SKEW_MS);
      }
      this.emit('strike', {
        latitude,
        longitude,
        distanceKm: distance,
        receivedAt: new Date(now),
        occurredAt,
      });
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }
}
