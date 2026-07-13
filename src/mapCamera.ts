import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import bundledFfmpegPath from 'ffmpeg-for-homebridge';
import {
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  H264Level,
  H264Profile,
  SRTPCryptoSuites,
  StreamRequestTypes,
  type API,
  type CameraController,
  type CameraStreamingDelegate,
  type Logger,
  type PrepareStreamRequest,
  type PrepareStreamResponse,
  type SnapshotRequest,
  type SnapshotRequestCallback,
  type StartStreamRequest,
  type StreamRequestCallback,
  type StreamingRequest,
} from 'homebridge';

import type { ResolvedConfig } from './config.js';
import type { LightningMapRenderer } from './mapRenderer.js';

interface PendingSession {
  address: string;
  localVideoPort: number;
  videoPort: number;
  videoSrtp: Buffer;
  videoSsrc: number;
}

interface OngoingSession {
  active: boolean;
  process: ChildProcess;
}

function profileName(profile: H264Profile): string {
  switch (profile) {
    case H264Profile.HIGH:
      return 'high';
    case H264Profile.MAIN:
      return 'main';
    default:
      return 'baseline';
  }
}

function levelName(level: H264Level): string {
  switch (level) {
    case H264Level.LEVEL4_0:
      return '4.0';
    case H264Level.LEVEL3_2:
      return '3.2';
    default:
      return '3.1';
  }
}

function allocateUdpPort(addressVersion: 'ipv4' | 'ipv6'): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(addressVersion === 'ipv6' ? 'udp6' : 'udp4');
    socket.once('error', reject);
    socket.bind(0, () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
}

export class LightningMapCamera implements CameraStreamingDelegate {
  public readonly controller: CameraController;
  private readonly pendingSessions = new Map<string, PendingSession>();
  private readonly ongoingSessions = new Map<string, OngoingSession>();

  constructor(
    private readonly log: Logger,
    private readonly api: API,
    private readonly config: ResolvedConfig,
    private readonly renderer: LightningMapRenderer,
  ) {
    this.controller = new api.hap.CameraController({
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          codec: {
            profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
          },
          resolutions: [
            [320, 180, 30],
            [320, 240, 15],
            [320, 240, 30],
            [480, 270, 30],
            [480, 360, 30],
            [640, 360, 30],
            [640, 480, 30],
            [1280, 720, 30],
            [1280, 960, 30],
            [1600, 1200, 30],
            [1920, 1080, 30],
          ],
        },
        audio: {
          codecs: [{
            type: AudioStreamingCodecType.AAC_ELD,
            samplerate: AudioStreamingSamplerate.KHZ_16,
          }],
        },
      },
    });
  }

  public handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    const startedAt = Date.now();
    this.log.debug('Lightning map snapshot requested at %dx%d.', request.width, request.height);
    void this.renderer.frame(request.width, request.height)
      .then(buffer => {
        this.log.debug(
          'Lightning map snapshot rendered at %dx%d in %d ms.',
          request.width,
          request.height,
          Date.now() - startedAt,
        );
        callback(undefined, buffer);
      })
      .catch(error => {
        const snapshotError = error instanceof Error ? error : new Error(String(error));
        this.log.warn('Lightning map snapshot failed: %s', snapshotError.message);
        callback(snapshotError);
      });
  }

  public prepareStream(
    request: PrepareStreamRequest,
    callback: (error?: Error, response?: PrepareStreamResponse) => void,
  ): void {
    void allocateUdpPort(request.addressVersion)
      .then(localVideoPort => {
        const videoSsrc = this.api.hap.CameraController.generateSynchronisationSource();
        this.pendingSessions.set(request.sessionID, {
          address: request.targetAddress,
          localVideoPort,
          videoPort: request.video.port,
          videoSrtp: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
          videoSsrc,
        });
        callback(undefined, {
          video: {
            port: localVideoPort,
            ssrc: videoSsrc,
            srtp_key: request.video.srtp_key,
            srtp_salt: request.video.srtp_salt,
          },
        });
      })
      .catch(error => {
        const streamError = error instanceof Error ? error : new Error(String(error));
        this.log.warn('Lightning map stream preparation failed: %s', streamError.message);
        callback(streamError);
      });
  }

  public handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback);
        return;
      case StreamRequestTypes.RECONFIGURE:
        callback();
        return;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
    }
  }

  public stop(): void {
    for (const sessionId of this.ongoingSessions.keys()) {
      this.stopStream(sessionId);
    }
    this.pendingSessions.clear();
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const session = this.pendingSessions.get(request.sessionID);
    if (!session) {
      callback(new Error(`Missing prepared stream session ${request.sessionID}.`));
      return;
    }
    const video = request.video;
    const address = session.address.includes(':') ? `[${session.address}]` : session.address;
    const target = `srtp://${address}:${session.videoPort}`
      + `?rtcpport=${session.videoPort}&localrtcpport=${session.localVideoPort}&pkt_size=${video.mtu}`;
    const ffmpegPath = this.config.camera.ffmpegPath ?? bundledFfmpegPath ?? 'ffmpeg';
    const arguments_ = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-framerate', '1',
      '-i', 'pipe:0',
      '-an', '-sn', '-dn',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-profile:v', profileName(video.profile),
      '-level:v', levelName(video.level),
      '-r', String(video.fps),
      '-g', String(video.fps),
      '-keyint_min', String(video.fps),
      '-b:v', `${video.max_bit_rate}k`,
      '-bufsize', `${video.max_bit_rate}k`,
      '-payload_type', String(video.pt),
      '-ssrc', String(session.videoSsrc),
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', session.videoSrtp.toString('base64'),
      target,
    ];
    const process = spawn(ffmpegPath, arguments_, {
      env: processEnvironment(),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const ongoing: OngoingSession = { active: true, process };
    this.ongoingSessions.set(request.sessionID, ongoing);
    this.pendingSessions.delete(request.sessionID);

    let callbackSent = false;
    process.once('spawn', () => {
      callbackSent = true;
      callback();
    });
    process.once('error', error => {
      this.log.warn('Lightning map FFmpeg failed to start: %s', error.message);
      if (!callbackSent) {
        callbackSent = true;
        callback(error);
      }
    });
    process.stderr?.on('data', data => this.log.debug('Lightning map FFmpeg: %s', String(data).trim()));
    process.once('exit', (code, signal) => {
      this.ongoingSessions.delete(request.sessionID);
      if (ongoing.active && code !== 0 && code !== 255) {
        this.log.warn('Lightning map stream exited with code %s and signal %s.', code, signal);
        this.controller.forceStopStreamingSession(request.sessionID);
      }
    });
    void this.pumpFrames(ongoing, video.width, video.height);
  }

  private async pumpFrames(session: OngoingSession, width: number, height: number): Promise<void> {
    try {
      while (session.active && session.process.stdin?.writable) {
        const frame = await this.renderer.frame(width, height);
        if (!session.process.stdin.write(frame)) {
          await once(session.process.stdin, 'drain');
        }
        await delay(1000);
      }
    } catch (error) {
      if (session.active) {
        this.log.warn('Lightning map frame stream failed: %s', error instanceof Error ? error.message : String(error));
        session.process.kill('SIGKILL');
      }
    }
  }

  private stopStream(sessionId: string): void {
    this.pendingSessions.delete(sessionId);
    const ongoing = this.ongoingSessions.get(sessionId);
    if (!ongoing) {
      return;
    }
    ongoing.active = false;
    ongoing.process.stdin?.end();
    ongoing.process.kill('SIGKILL');
    this.ongoingSessions.delete(sessionId);
  }
}

function processEnvironment(): NodeJS.ProcessEnv {
  return process.env;
}
