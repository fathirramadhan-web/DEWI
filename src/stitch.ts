import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ANCHOR,
  FPS,
  OUT_DIR,
  STAGE,
  STILL_SCALE,
  THEMES,
  TOUR,
  VIDEO,
  tourIndex,
} from './config.ts';
import { buildPreviewHtml } from './preview.ts';
import { entryDir } from './run-id.ts';
import type { GapBucket, SceneEntry } from './types.ts';
import { voiceMissingMessage, voiceReady } from './voice.ts';

const FPS_FLOOR = Number(process.env.DEMO_FPS_FLOOR ?? FPS * 0.75);
const MOTION_FLOOR = Number(process.env.DEMO_MOTION_FLOOR ?? 1);

function isJudgeable(clip: { motionSeconds: number }): boolean {
  return clip.motionSeconds >= MOTION_FLOOR;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-1200)}`))
    );
  });
}

async function readSceneEntries(): Promise<SceneEntry[]> {
  const dir = entryDir();
  const files = await readdir(dir).catch(() => [] as string[]);
  const entries = await Promise.all(
    files
      .filter((name) => name.endsWith('.json'))
      .map(
        async (name) =>
          JSON.parse(await readFile(join(dir, name), 'utf8')) as SceneEntry
      )
  );

  return entries.sort(
    (a, b) =>
      tourIndex(a.scene) - tourIndex(b.scene) || a.scene.localeCompare(b.scene)
  );
}

async function concatTour(
  theme: string,
  clipRelPaths: string[]
): Promise<string | null> {
  if (clipRelPaths.length < 2) {
    return null;
  }

  const listPath = join(OUT_DIR, `.tour-${theme}.txt`);
  const listBody = clipRelPaths
    .map((rel) => {
      const normalized = join(OUT_DIR, rel).replace(/\\/g, '/');
      return `file '${normalized}'`;
    })
    .join('\n');

  await writeFile(listPath, `${listBody}\n`);

  const outFile = join(OUT_DIR, theme, 'full-tour.mp4');
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outFile,
  ]);
  await rm(listPath, { force: true });

  return `${theme}/full-tour.mp4`;
}

type ManifestAsset = {
  stills: string[];
  mp4: string;
  webm: string | null;
  poster: string;
  seconds: number;
  fps: number;
  worstGapMs: number;
  motionSeconds: number;
  motionGaps: number;
  gaps: GapBucket[];
  spoken: number;
};

type ManifestScene = {
  scene: string;
  title: string;
  blurb: string;
  ref: string | null;
  assets: Record<string, ManifestAsset>;
};

async function mergeManifest(fresh: ManifestScene[]): Promise<ManifestScene[]> {
  const existing = await readFile(join(OUT_DIR, 'manifest.json'), 'utf8')
    .then((raw) => (JSON.parse(raw) as { scenes?: ManifestScene[] }).scenes ?? [])
    .catch(() => [] as ManifestScene[]);

  const map = new Map<string, ManifestScene>();
  for (const item of existing) {
    map.set(item.scene, item);
  }
  for (const item of fresh) {
    const prev = map.get(item.scene);
    map.set(item.scene, {
      ...item,
      assets: { ...prev?.assets, ...item.assets },
    });
  }

  return [...map.values()].sort(
    (a, b) =>
      tourIndex(a.scene) - tourIndex(b.scene) || a.scene.localeCompare(b.scene)
  );
}

export default async function stitch(): Promise<void> {
  const entries = await readSceneEntries();
  if (entries.length === 0) {
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });

  const slowClips = entries.filter(
    (entry) => isJudgeable(entry.clip) && entry.clip.measured < FPS_FLOOR
  );

  process.stdout.write('\n  captured\n');
  for (const entry of entries) {
    const judgeable = isJudgeable(entry.clip);
    const flag = judgeable && entry.clip.measured < FPS_FLOOR ? '!' : ' ';
    const rateLabel = judgeable
      ? `${entry.clip.measured.toFixed(1).padStart(5)}fps in motion  worst gap ${entry.clip.worstGapMs.toFixed(0).padStart(3)}ms  `
      : `${'held'.padStart(8)}, barely moves  `;
    process.stdout.write(
      `  ${flag} ${entry.theme.padEnd(5)} ${entry.scene.padEnd(16)} ` +
        rateLabel +
        `${entry.clip.seconds.toFixed(1).padStart(5)}s  ` +
        `${String(entry.clip.frames).padStart(5)} frames  ` +
        `${entry.stills.length} still(s)  ` +
        `${String(entry.clip.spoken).padStart(2)} spoken` +
        `${entry.clip.overrunSeconds > 0.08 ? ` (+${entry.clip.overrunSeconds.toFixed(1)}s held)` : ''}\n`
    );
  }

  const filmed: ManifestScene[] = [...new Set(entries.map((e) => e.scene))]
    .sort((a, b) => tourIndex(a) - tourIndex(b) || a.localeCompare(b))
    .map((sceneName) => {
      const sample = entries.find((e) => e.scene === sceneName)!;
      return {
        scene: sceneName,
        title: sample.title,
        blurb: sample.blurb,
        ref: sample.ref ?? null,
        assets: Object.fromEntries(
          entries
            .filter((e) => e.scene === sceneName)
            .map((e) => [
              e.theme,
              {
                stills: e.stills,
                mp4: e.clip.mp4,
                webm: e.clip.webm,
                poster: e.clip.poster,
                seconds: Number(e.clip.seconds.toFixed(2)),
                fps: Number(e.clip.measured.toFixed(1)),
                worstGapMs: Number(e.clip.worstGapMs.toFixed(0)),
                motionSeconds: Number(e.clip.motionSeconds.toFixed(2)),
                motionGaps: e.clip.motionGaps,
                gaps: e.clip.gapHistogram,
                spoken: e.clip.spoken,
              },
            ])
        ),
      };
    });

  const scenes = await mergeManifest(filmed);
  const tours: Record<string, string | null> = {};
  for (const theme of TOUR ? THEMES : []) {
    const clips = scenes
      .map((s) => s.assets[theme]?.mp4)
      .filter((c): c is string => Boolean(c));
    tours[theme] = await concatTour(theme, clips);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    filmedAt: ANCHOR.toISOString(),
    stage: { ...STAGE, fps: FPS, stillScale: STILL_SCALE, video: VIDEO },
    themes: THEMES,
    tours,
    scenes,
  };

  await writeFile(
    join(OUT_DIR, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await writeFile(join(OUT_DIR, 'index.html'), buildPreviewHtml());
  await rm(entryDir(), { recursive: true, force: true });

  const clipCount = scenes.reduce(
    (sum, s) => sum + Object.keys(s.assets).length,
    0
  );

  process.stdout.write(
    `\n  ${OUT_DIR}\\manifest.json  (${manifest.scenes.length} scenes, ${clipCount} clips)\n` +
      `  ${OUT_DIR}\\index.html     open to preview the corpus\n`
  );

  if (!(await voiceReady())) {
    process.stdout.write(`\n${voiceMissingMessage()}`);
  }

  if (slowClips.length > 0) {
    process.stdout.write(
      `\n  ${slowClips.length} clip(s) under ${FPS_FLOOR}fps in motion.\n`
    );
  }
}
