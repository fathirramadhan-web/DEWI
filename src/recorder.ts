import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';

import type { CDPSession, Page } from '@playwright/test';

import {
  FPS,
  STAGE,
  TRACE_FRAMES,
  VIDEO,
  VIDEO_SCALE,
  WEBM,
} from './config.ts';
import type { ClipMetrics, GapBucket } from './types.ts';
import type { SpeechMark } from './voice.ts';
import { buildMixArgs, synthesizeMarks, voiceReady } from './voice.ts';

type CapturedFrame = {
  at: number;
  file: string;
};

const FALLBACK_MOTION_GAP = 0.05;
const FRAME_QUALITY = Number(process.env.DEMO_FRAME_QUALITY ?? 80);

function nowSeconds(): number {
  return Date.now() / 1000;
}

function buildEncoderArgs(kind: 'videotoolbox' | 'x264'): string[] {
  if (kind === 'videotoolbox') {
    return [
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      process.env.DEMO_BITRATE ?? '36M',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
    ];
  }

  return [
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    String(VIDEO.crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
  ];
}

function queryEncoders(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-encoders'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(output));
  });
}

let cachedEncoder: Promise<'videotoolbox' | 'x264'> | null = null;

function selectEncoder(): Promise<'videotoolbox' | 'x264'> {
  const forced = process.env.DEMO_ENCODER;
  if (forced === 'x264' || forced === 'videotoolbox') {
    return Promise.resolve(forced);
  }
  if (platform() !== 'darwin') {
    return Promise.resolve('x264');
  }
  return queryEncoders().then((encoders) =>
    encoders.includes('h264_videotoolbox') ? 'videotoolbox' : 'x264'
  );
}

async function getVideoArgs(): Promise<string[]> {
  cachedEncoder ??= selectEncoder();
  return buildEncoderArgs(await cachedEncoder);
}

let cachedHasNice: Promise<boolean> | null = null;

function checkNiceAvailable(): Promise<boolean> {
  if (platform() === 'win32') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const child = spawn('nice', ['-n', '0', 'true'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function runProcess(bin: string, args: string[]): Promise<void> {
  cachedHasNice ??= checkNiceAvailable();
  const useNice = await cachedHasNice;

  return new Promise((resolve, reject) => {
    const child = useNice
      ? spawn('nice', ['-n', '12', bin, ...args], {
          stdio: ['ignore', 'ignore', 'pipe'],
        })
      : spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${bin} exited ${code}\n${stderr.split('\n').slice(-24).join('\n')}`
        )
      );
    });
  });
}

export class ScreencastRecorder {
  private cdp: CDPSession | null = null;
  private frames: CapturedFrame[] = [];
  private pendingWrites: Promise<unknown>[] = [];
  private frameCounter = 0;
  private startedAt = 0;
  private pausedOffset = 0;
  private pausedAt = 0;
  private marks: SpeechMark[] = [];
  private motionSpans: { from: number; to: number }[] = [];
  private motionOpenedAt: number | null = null;
  private motionDepth = 0;

  constructor(
    private readonly page: Page,
    private readonly frameDir: string
  ) {}

  elapsed(): number {
    const currentPause = this.pausedAt ? nowSeconds() - this.pausedAt : 0;
    return Math.max(
      0,
      nowSeconds() - this.startedAt - this.pausedOffset - currentPause
    );
  }

  mark(text: string): void {
    this.marks.push({ at: this.elapsed(), text });
  }

  motion(state: 'start' | 'end'): void {
    if (state === 'start') {
      this.motionOpenedAt ??= nowSeconds() - this.pausedOffset;
      this.motionDepth += 1;
      return;
    }

    this.motionDepth = Math.max(0, this.motionDepth - 1);
    if (this.motionDepth > 0 || this.motionOpenedAt === null) {
      return;
    }

    this.motionSpans.push({
      from: this.motionOpenedAt,
      to: nowSeconds() - this.pausedOffset,
    });
    this.motionOpenedAt = null;
  }

  async start(): Promise<void> {
    await mkdir(this.frameDir, { recursive: true });
    const session = await this.page.context().newCDPSession(this.page);
    this.cdp = session;

    session.on('Page.screencastFrame', (event) => {
      const payload = event as unknown as {
        data: string;
        sessionId: number;
        metadata?: { timestamp?: number };
      };

      void session
        .send('Page.screencastFrameAck', { sessionId: payload.sessionId })
        .catch(() => undefined);

      const at = (payload.metadata?.timestamp ?? nowSeconds()) - this.pausedOffset;
      const file = `f-${String(this.frameCounter++).padStart(6, '0')}.jpg`;
      this.frames.push({ at, file });
      this.pendingWrites.push(
        writeFile(join(this.frameDir, file), Buffer.from(payload.data, 'base64'))
      );
    });

    this.startedAt = nowSeconds();
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: FRAME_QUALITY,
      everyNthFrame: 1,
    });
  }

  async pause(): Promise<void> {
    if (!this.cdp || this.pausedAt) {
      return;
    }
    await this.cdp.send('Page.stopScreencast').catch(() => undefined);
    this.pausedAt = nowSeconds();
  }

  async resume(): Promise<void> {
    if (!this.cdp || !this.pausedAt) {
      return;
    }
    this.pausedOffset += nowSeconds() - this.pausedAt;
    this.pausedAt = 0;
    await this.cdp
      .send('Page.startScreencast', {
        format: 'jpeg',
        quality: 95,
        everyNthFrame: 1,
      })
      .catch(() => undefined);
  }

  async stop(outputBase: string): Promise<ClipMetrics> {
    const session = this.cdp;
    if (!session) {
      throw new Error('ScreencastRecorder.stop called before start');
    }

    await session.send('Page.stopScreencast').catch(() => undefined);
    await session.detach().catch(() => undefined);
    this.cdp = null;
    await Promise.all(this.pendingWrites);

    const frames = this.frames;
    if (frames.length < 2) {
      throw new Error(`Not enough frames captured (${frames.length})`);
    }

    const totalSpan = frames[frames.length - 1]!.at - frames[0]!.at;
    const seconds = totalSpan > 0 ? totalSpan : nowSeconds() - this.startedAt;
    const minFrameDuration = 1 / FPS;

    const spans = this.motionSpans;
    const spanGaps = spans.flatMap((span) => {
      const inside = frames.filter(
        (frame) => frame.at >= span.from && frame.at <= span.to
      );
      return inside
        .slice(1)
        .map((frame, i) => frame.at - inside[i]!.at)
        .filter((gap) => gap > 0);
    });

    const gaps =
      spans.length > 0
        ? spanGaps
        : frames
            .slice(1)
            .map((frame, i) => frame.at - frames[i]!.at)
            .filter((gap) => gap > 0 && gap <= FALLBACK_MOTION_GAP);

    const buckets: [string, number][] = [
      ['<=17ms (60fps)', 0.017],
      ['<=34ms (30fps)', 0.034],
      ['<=50ms (20fps)', 0.05],
      ['<=100ms (10fps)', 0.1],
      ['<=250ms', 0.25],
      ['slower', Infinity],
    ];
    let lowerBound = 0;
    const gapHistogram: GapBucket[] = buckets.map(([label, ceiling]) => {
      const count = gaps.filter(
        (gap) => gap > lowerBound && gap <= ceiling
      ).length;
      lowerBound = ceiling;
      return { label, count };
    });

    if (TRACE_FRAMES) {
      const summary = gapHistogram
        .map((b) => `${b.label}: ${b.count}`)
        .join('  ');
      process.stdout.write(`    gaps  ${summary}\n`);
    }

    const movingTotal = gaps.reduce((acc, g) => acc + g, 0);
    const measured = movingTotal > 0 ? gaps.length / movingTotal : 0;
    const worstGapMs = gaps.length > 0 ? Math.max(...gaps) * 1000 : 0;
    const motionGaps = gaps.length;
    const motionSeconds =
      spans.length > 0
        ? spans.reduce((acc, span) => acc + (span.to - span.from), 0)
        : movingTotal;

    const concatLines = ['ffconcat version 1.0'];
    frames.forEach((frame, idx) => {
      const next = frames[idx + 1];
      const duration = next
        ? Math.max(next.at - frame.at, minFrameDuration / 4)
        : minFrameDuration;
      concatLines.push(`file '${frame.file}'`, `duration ${duration.toFixed(6)}`);
    });
    // Repeat final frame so ffmpeg concat honors its duration.
    concatLines.push(`file '${frames[frames.length - 1]!.file}'`);

    const concatPath = join(this.frameDir, 'clip.ffconcat');
    await writeFile(concatPath, `${concatLines.join('\n')}\n`);

    const capturedWidth = STAGE.width * VIDEO_SCALE;
    const capturedHeight = STAGE.height * VIDEO_SCALE;
    const scaleFilter =
      capturedWidth === VIDEO.width && capturedHeight === VIDEO.height
        ? ''
        : `scale=${VIDEO.width}:${VIDEO.height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
          `pad=${VIDEO.width}:${VIDEO.height}:(ow-iw)/2:(oh-ih)/2:color=black,`;

    const mp4Path = `${outputBase}.mp4`;
    const webmPath = `${outputBase}.webm`;
    const posterPath = `${outputBase}.poster.jpg`;
    const silentPath = `${outputBase}.silent.mp4`;
    const encodeArgs = await getVideoArgs();

    const spoken = (await voiceReady()) ? await synthesizeMarks(this.marks) : [];
    const videoTarget = spoken.length > 0 ? silentPath : mp4Path;

    await runProcess('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatPath,
      '-vf',
      `${scaleFilter}fps=${FPS}`,
      ...encodeArgs,
      '-r',
      String(FPS),
      videoTarget,
    ]);

    let overrunSeconds = 0;
    if (spoken.length > 0) {
      const mix = buildMixArgs(silentPath, spoken, mp4Path, seconds, encodeArgs);
      overrunSeconds = mix.overrun;
      await runProcess('ffmpeg', mix.args);
      await rm(silentPath, { force: true });
    }

    if (WEBM) {
      await runProcess('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        mp4Path,
        '-c:v',
        'libvpx-vp9',
        '-crf',
        String(VIDEO.webmCrf),
        '-b:v',
        '0',
        '-row-mt',
        '1',
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        ...(spoken.length > 0 ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-an']),
        webmPath,
      ]);
    }

    await runProcess('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      mp4Path,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      posterPath,
    ]);

    await rm(this.frameDir, { recursive: true, force: true });

    return {
      frames: frames.length,
      seconds,
      measured,
      worstGapMs,
      motionSeconds,
      motionGaps,
      gapHistogram,
      mp4: mp4Path,
      webm: WEBM ? webmPath : null,
      poster: posterPath,
      spoken: spoken.length,
      overrunSeconds,
    };
  }

  async discard(): Promise<void> {
    await this.cdp?.send('Page.stopScreencast').catch(() => undefined);
    await this.cdp?.detach().catch(() => undefined);
    this.cdp = null;
    await rm(this.frameDir, { recursive: true, force: true });
  }
}
