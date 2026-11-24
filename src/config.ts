import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { DemoConfig, Theme } from './types.ts';

const CONFIG_PATH = process.env.DEMO_CONFIG;

if (!CONFIG_PATH) {
  throw new Error(
    'DEMO_CONFIG is not set. Run via `node bin/cli.mjs run` or `npm run demo`.'
  );
}

const resolvedConfigPath = resolve(CONFIG_PATH);
const loaded = (await import(pathToFileURL(resolvedConfigPath).href)) as {
  default: DemoConfig;
};

export const demo: DemoConfig = loaded.default;
export type ConfigServer = Awaited<ReturnType<NonNullable<typeof demo.mock>>>;

export const ENGINE_DIR = fileURLToPath(new URL('./', import.meta.url));
export const STUDIO_ROOT = resolve(ENGINE_DIR, '..');
export const PROJECT = process.env.DEMO_PROJECT
  ? resolve(process.env.DEMO_PROJECT)
  : dirname(resolvedConfigPath);
export const APP_ROOT = process.env.DEMO_APP_ROOT
  ? resolve(process.env.DEMO_APP_ROOT)
  : PROJECT;

const rawSite = demo.site?.trim();

if (rawSite && demo.build) {
  throw new Error('demo.config.ts: specify either `site` or `build`, not both.');
}
if (!rawSite && !demo.build) {
  throw new Error('demo.config.ts: either `site` or `build` is required.');
}
if (rawSite && !/^https?:\/\//.test(rawSite)) {
  throw new Error(`demo.config.ts: \`site\` must be an http(s) URL, got "${rawSite}"`);
}
if (rawSite) {
  const parsed = new URL(rawSite);
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(
      `demo.config.ts: \`site\` must be an origin only (got "${rawSite}"). ` +
        `Use site: "${parsed.origin}" and place "${parsed.pathname}${parsed.search}${parsed.hash}" in entries.app.path.`
    );
  }
}

export const SITE: string | null = rawSite ?? null;

function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`demo.config.ts: missing required field \`${name}\``);
  }
  return value;
}

requireField(demo.name, 'name');
requireField(demo.clock?.timezone, 'clock.timezone');
requireField(demo.entries?.app, 'entries.app');

if (!SITE) {
  requireField(demo.build?.command, 'build.command');
  requireField(demo.build?.output, 'build.output');
  requireField(demo.clock?.anchor, 'clock.anchor');
  requireField(demo.mock, 'mock');
}

export const STAGE = {
  width: Number(process.env.DEMO_WIDTH ?? demo.stage?.width ?? 1920),
  height: Number(process.env.DEMO_HEIGHT ?? demo.stage?.height ?? 1080),
} as const;

export const VIDEO_SCALE = Number(process.env.DEMO_VIDEO_SCALE ?? 1);
export const STILL_SCALE = Number(process.env.DEMO_STILL_SCALE ?? 2);

export const TZ = demo.clock?.timezone ?? 'UTC';
export const LOCALE = demo.clock?.locale ?? 'en-US';
export const PINNED = Boolean(demo.clock?.anchor);
export const ANCHOR = demo.clock?.anchor ? new Date(demo.clock.anchor) : new Date();

export const FPS = Number(
  process.env.DEMO_FPS ?? (STAGE.width * VIDEO_SCALE >= 3840 ? 30 : 60)
);

export const VIDEO = {
  width: STAGE.width * VIDEO_SCALE,
  height: STAGE.height * VIDEO_SCALE,
  crf: 18,
  webmCrf: 32,
} as const;

export const WEBM = process.env.DEMO_WEBM === '1';
export const TOUR = process.env.DEMO_TOUR ? process.env.DEMO_TOUR !== '0' : true;

export function tourIndex(sceneName: string): number {
  const order = demo.tour ?? [];
  const idx = order.indexOf(sceneName);
  return idx === -1 ? order.length : idx;
}

export const THEMES: Theme[] = (
  process.env.DEMO_THEMES ?? (demo.themes ?? ['dark']).join(',')
)
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean) as Theme[];

export const PORT = Number(process.env.DEMO_PORT ?? 5499);
export const BASE_URL = SITE ?? `http://127.0.0.1:${PORT}`;
export const OUT_DIR = process.env.DEMO_OUT
  ? resolve(process.env.DEMO_OUT)
  : join(PROJECT, 'demo-out');
export const FRAME_DIR = join(OUT_DIR, '.frames');

export const WORKERS = Number(
  process.env.DEMO_WORKERS ?? (STAGE.width * VIDEO_SCALE >= 3840 ? 1 : 2)
);

export const TRACE_NAV = Boolean(process.env.DEMO_TRACE_NAV);
export const TRACE_FRAMES = Boolean(process.env.DEMO_TRACE_FRAMES);
export const VOICE_MODE = (process.env.DEMO_VOICE ?? 'auto').toLowerCase();
export const VOICE_ENABLED = VOICE_MODE !== '0' && VOICE_MODE !== 'off' && VOICE_MODE !== 'false';
