import { ChildProcess, ChildProcessWithoutNullStreams, spawn, StdioNull, StdioPipe } from 'child_process';
import EventEmitter from 'events';
import { createServer, Server } from 'net';
import { Logger } from './logger';
import { listenServer, MP4Atom, parseFragmentedMP4 } from './recordingDelegate';

interface PrebufferFmp4 {
  atom: MP4Atom;
  time: number;
}

export interface Mp4Session {
  server: Server;
  process: ChildProcess;
}

const defaultPrebufferDuration = 15000;

let prebufferSession: Mp4Session;

export class PreBuffer {
  prebufferFmp4: Array<PrebufferFmp4> = [];
  events = new EventEmitter();
  released = false;
  ftyp?: MP4Atom;
  moov?: MP4Atom;
  idrInterval = 0;
  prevIdr = 0;

  private readonly log: Logger;
  private readonly ffmpegInput: string;
  private readonly cameraName;
  private readonly ffmpegPath: string;
  //private process: ChildProcessWithoutNullStreams;

  constructor(log: Logger, ffmpegInput: string, cameraName: string, videoProcessor: string) {
    this.log = log;
    this.ffmpegInput = ffmpegInput;
    this.cameraName = cameraName;
    this.ffmpegPath = videoProcessor;
  }

  async startPreBuffer(): Promise<Mp4Session> {
    if(prebufferSession) return prebufferSession;
    this.log.debug('start prebuffer', this.cameraName);
    // const acodec = [
    //   '-acodec',
    //   'copy'
    // ];

    const vcodec = [
      '-vcodec',
      'copy'
    ];

    const fmp4OutputServer: Server = createServer(async(socket) => {
      fmp4OutputServer.close();
      const parser = parseFragmentedMP4(socket);
      for await (const atom of parser) {
        const now = Date.now();
        if (!this.ftyp) {
          this.ftyp = atom;
        } else if (!this.moov) {
          this.moov = atom;
        } else {
          if (atom.type === 'mdat') {
            if (this.prevIdr)
              this.idrInterval = now - this.prevIdr;
            this.prevIdr = now;
          }

          this.prebufferFmp4.push({
            atom,
            time: now
          });
        }

        while (this.prebufferFmp4.length && this.prebufferFmp4[0].time < now - defaultPrebufferDuration) {
          this.prebufferFmp4.shift();
        }

        this.events.emit('atom', atom);
      }
    });
    const fmp4Port = await listenServer(fmp4OutputServer);

    const ffmpegOutput = [
      '-f', 'mp4',
      //  ...acodec,
      ...vcodec,
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      `tcp://127.0.0.1:${fmp4Port}`
    ];

    const args: Array<string> = [];
    args.push(...this.ffmpegInput.split(' '));
    args.push(...ffmpegOutput);

    this.log.info(this.ffmpegPath+' '+args.join(' '), this.cameraName);

    const debug = false;

    const stdioValue: StdioPipe|StdioNull = debug? 'pipe': 'ignore';
    const cp = spawn(this.ffmpegPath, args, { env: process.env, stdio: stdioValue});

    if (debug) {
      cp.stdout?.on('data', data => this.log.debug(data.toString(), this.cameraName));
      cp.stderr?.on('data', data => this.log.debug(data.toString(), this.cameraName));
    }

    prebufferSession = {server:fmp4OutputServer, process:cp};

    return prebufferSession;
  }

  async getVideo(requestedPrebuffer: number): Promise<Array<string>>{

    const server = new Server(socket => {
      server.close();

      // let cleanup: () => void;

      const writeAtom = (atom: MP4Atom): void => {
        socket.write(Buffer.concat([atom.header, atom.data]));
      };

      if (this.ftyp) {
        writeAtom(this.ftyp);
      }
      if (this.moov) {
        writeAtom(this.moov);
      }
      const now = Date.now();
      let needMoof = true;
      for (const prebuffer of this.prebufferFmp4) {
        if (prebuffer.time < now - requestedPrebuffer)
          continue;
        if (needMoof && prebuffer.atom.type !== 'moof')
          continue;
        needMoof = false;
        // console.log('writing prebuffer atom', prebuffer.atom);
        writeAtom(prebuffer.atom);
      }

      this.events.on('atom', writeAtom);

      const cleanup = (): void => {
        this.log.info('prebuffer request ended', this.cameraName);
        this.events.removeListener('atom', writeAtom);
        this.events.removeListener('killed', cleanup);
        socket.removeAllListeners();
        socket.destroy();
      };

      this.events.once('killed', cleanup);
      socket.once('end', cleanup);
      socket.once('close', cleanup);
      socket.once('error', cleanup);
    });

    setTimeout(() => server.close(), 30000);

    const port = await listenServer(server);

    const ffmpegInput: Array<string> = [
      '-f', 'mp4',
      '-i', `tcp://127.0.0.1:${port}`
    ];

    return ffmpegInput;
  }
}