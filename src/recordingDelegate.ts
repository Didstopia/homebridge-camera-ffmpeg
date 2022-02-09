import {
  API,
  APIEvent,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  CameraController,
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  H264Level,
  H264Profile,
  HAP,
  HDSProtocolSpecificErrorReason,
  RecordingPacket
} from 'homebridge';
import { VideoConfig } from './configTypes';
import ffmpegPath from 'ffmpeg-for-homebridge';
import { Logger } from './logger';
import { ChildProcess, ChildProcessWithoutNullStreams, spawn, StdioNull, StdioPipe } from 'child_process';
import fs from 'fs';
import { AddressInfo, Socket, Server, createServer } from 'net';
import { once } from 'events';
import { Readable } from 'stream';
import { Mp4Session, PreBuffer } from './prebuffer';

export interface MP4Atom {
  header: Buffer;
  length: number;
  type: string;
  data: Buffer;
}

export interface FFMpegFragmentedMP4Session {
  socket: Socket;
  cp: ChildProcess;
  generator: AsyncGenerator<MP4Atom>;
}

export const PREBUFFER_LENGTH = 4000;
export const FRAGMENTS_LENGTH = 4000;

export async function listenServer(server: Server): Promise<number> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const port = 10000 + Math.round(Math.random() * 30000);
    server.listen(port);
    await once(server, 'listening');
    return (server.address() as AddressInfo).port;
  }
}

export async function readLength(readable: Readable, length: number): Promise<Buffer> {
  if (!length) {
    return Buffer.alloc(0);
  }

  {
    const ret = readable.read(length);
    if (ret) {
      return ret;
    }
  }

  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    const r = () => {
      const ret = readable.read(length);
      if (ret) {
        cleanup();
        resolve(ret);
      }
    };

    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    const e = () => {
      cleanup();
      reject(new Error(`stream ended during read for minimum ${length} bytes`));
    };

    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    const cleanup = () => {
      readable.removeListener('readable', r);
      readable.removeListener('end', e);
    };

    readable.on('readable', r);
    readable.on('end', e);
  });
}

export async function* parseFragmentedMP4(readable: Readable): AsyncGenerator<MP4Atom> {
  while (true) {
    const header = await readLength(readable, 8);
    const length = header.readInt32BE(0) - 8;
    const type = header.slice(4).toString();
    const data = await readLength(readable, length);

    yield {
      header,
      length,
      type,
      data
    };
  }
}

export class RecordingDelegate implements CameraRecordingDelegate {
  private readonly hap: HAP;
  private readonly log: Logger;
  private readonly cameraName: string;
  private readonly videoConfig: VideoConfig;
  private process?: ChildProcessWithoutNullStreams;

  private readonly videoProcessor: string;
  readonly controller?: CameraController;
  private preBufferSession?: Mp4Session;
  private preBuffer?: PreBuffer;

  constructor(log: Logger, cameraName: string, videoConfig: VideoConfig, api: API, hap: HAP, videoProcessor?: string) { // eslint-disable-line @typescript-eslint/explicit-module-boundary-types

    this.log = log;
    this.hap = hap;
    this.cameraName = cameraName;
    this.videoConfig = videoConfig;
    this.videoProcessor = videoProcessor || ffmpegPath || 'ffmpeg';

    api.on(APIEvent.SHUTDOWN, () => {
      if(this.preBufferSession) {
        this.preBufferSession.process?.kill();
        this.preBufferSession.server?.close();
      }
    });
  }

  // FIXME: Implement
  updateRecordingActive(active: boolean): void {
    throw new Error('Method not implemented.');
  }

  // FIXME: Implement
  updateRecordingConfiguration(configuration: CameraRecordingConfiguration): void {
    throw new Error('Method not implemented.');
  }

  // FIXME: Implement
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket, any, unknown> {
    throw new Error('Method not implemented.');
  }

  // FIXME: Implement
  acknowledgeStream?(streamId: number): void {
    throw new Error('Method not implemented.');
  }

  // FIXME: Implement
  closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason): void {
    throw new Error('Method not implemented.');
  }

  async startPreBuffer(): Promise<void> {
    if(this.videoConfig.prebuffer) {
      // looks like the setupAcessory() is called multiple times during startup. Ensure that Prebuffer runs only once
      if(!this.preBuffer) {
        this.preBuffer = new PreBuffer(this.log, this.videoConfig.source ?? '', this.cameraName, this.videoProcessor);
        if(!this.preBufferSession) this.preBufferSession = await this.preBuffer.startPreBuffer();
      }
    }
  }

  async * handleFragmentsRequests(configuration: CameraRecordingConfiguration): AsyncGenerator<Buffer, void, unknown> {
    this.log.debug('video fragments requested', this.cameraName);

    const iframeIntervalSeconds = 4;

    let samplerate = 44.1;
    switch (configuration.audioCodec.samplerate) {
      case AudioRecordingSamplerate.KHZ_8:
        samplerate = 8;
        break;
      case AudioRecordingSamplerate.KHZ_16:
        samplerate = 16;
        break;
      case AudioRecordingSamplerate.KHZ_24:
        samplerate = 24;
        break;
      case AudioRecordingSamplerate.KHZ_32:
        samplerate = 32;
        break;
      case AudioRecordingSamplerate.KHZ_44_1:
        samplerate = 44.1;
        break;
      case AudioRecordingSamplerate.KHZ_48:
        samplerate = 48;
        break;
    }

    const audioArgs: Array<string> = [
      '-acodec', 'libfdk_aac',
      ...(configuration.audioCodec.type === AudioRecordingCodecType.AAC_LC ?
        ['-profile:a', 'aac_low'] :
        ['-profile:a', 'aac_eld']),
      '-ar', `${samplerate}k`,
      '-b:a', `${configuration.audioCodec.bitrate}k`,
      '-ac', `${configuration.audioCodec.audioChannels}`
    ];

    const profile =
      configuration.videoCodec.parameters.profile === H264Profile.HIGH
        ? 'high'
        : configuration.videoCodec.parameters.profile === H264Profile.MAIN
          ? 'main'
          : 'baseline';

    const level =
      configuration.videoCodec.parameters.level === H264Level.LEVEL4_0
        ? '4.0'
        : configuration.videoCodec.parameters.level === H264Level.LEVEL3_2
          ? '3.2'
          : '3.1';

    const videoArgs: Array<string> = [
      '-an',
      '-sn',
      '-dn',
      '-codec:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',

      '-profile:v', profile,
      '-level:v', level,
      '-b:v', `${configuration.videoCodec.parameters.bitRate}k`,
      '-force_key_frames', `expr:eq(t,n_forced*${iframeIntervalSeconds})`,
      '-r', configuration.videoCodec.resolution[2].toString()
    ];

    const ffmpegInput: Array<string> = [];

    if (this.videoConfig.prebuffer) {
      // const input: Array<string> = await this.preBuffer.getVideo(configuration.mediaContainerConfiguration.prebufferLength);
      const input: Array<string> | undefined = await this.preBuffer?.getVideo(
        configuration.mediaContainerConfiguration.fragmentLength
      );
      if (input) {
        ffmpegInput.push(...input);
      }
    } else if (this.videoConfig?.source) {
      ffmpegInput.push(...this.videoConfig.source.split(' '));
    }

    this.log.debug('Start recording...', this.cameraName);

    const session = await this.startFFMPegFragmetedMP4Session(this.videoProcessor, ffmpegInput, audioArgs, videoArgs);
    this.log.info('Recording started', this.cameraName);

    const { socket, cp, generator } = session;
    let pending: Array<Buffer> = [];
    let filebuffer: Buffer = Buffer.alloc(0);
    try {
      for await (const box of generator) {
        const { header, type, length, data } = box;

        pending.push(header, data);

        if (type === 'moov'  || type === 'mdat') {
          const fragment = Buffer.concat(pending);
          filebuffer = Buffer.concat([filebuffer, Buffer.concat(pending)]);
          pending = [];
          yield fragment;
        }
        this.log.debug('mp4 box type '+ type+' and lenght: '+ length, this.cameraName);
      }
    } catch (e) {
      this.log.info('Recoding completed. '+e, this.cameraName);
      /*
            const homedir = require('os').homedir();
            const path = require('path');
            const writeStream = fs.createWriteStream(homedir+path.sep+Date.now()+'_video.mp4');
            writeStream.write(filebuffer);
            writeStream.end();
            */
    } finally {
      socket.destroy();
      cp.kill();
      //this.server.close;
    }
  }



  async startFFMPegFragmetedMP4Session(ffmpegPath: string, ffmpegInput: Array<string>, audioOutputArgs: Array<string>, videoOutputArgs: Array<string>): Promise<FFMpegFragmentedMP4Session> {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async(resolve) => {
      const server = createServer(socket => {
        server.close();
        // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
        async function* generator() {
          while (true) {
            const header = await readLength(socket, 8);
            const length = header.readInt32BE(0) - 8;
            const type = header.slice(4).toString();
            const data = await readLength(socket, length);

            yield {
              header,
              length,
              type,
              data
            };
          }
        }
        resolve({
          socket,
          cp,
          generator: generator()
        });
      });
      const serverPort = await listenServer(server);
      const args: Array<string> = [];

      args.push(...ffmpegInput);

      //args.push(...audioOutputArgs);

      args.push('-f', 'mp4');
      args.push(...videoOutputArgs);
      args.push('-fflags',
        '+genpts',
        '-reset_timestamps',
        '1');
      args.push(
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        'tcp://127.0.0.1:'+serverPort
      );

      this.log.debug(ffmpegPath+' '+args.join(' '), this.cameraName);

      const debug = false;

      const stdioValue: StdioPipe|StdioNull = debug? 'pipe': 'ignore';
      this.process = spawn(ffmpegPath, args, { env: process.env, stdio: stdioValue}) as ChildProcessWithoutNullStreams;
      const cp = this.process;

      if (debug) {
        cp.stdout?.on('data', data => this.log.debug(data.toString(), this.cameraName));
        cp.stderr?.on('data', data => this.log.debug(data.toString(), this.cameraName));
      }
    });
  }
}