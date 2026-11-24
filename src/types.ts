import type { Page } from '@playwright/test';

export type Theme = 'light' | 'dark';

export type ReadyCheck = (page: Page) => Promise<void>;

export type MockContext = {
  reference: Date;
  entry: string;
  signedIn: boolean;
};

export type EntryConfig = {
  path: string;
  ready: ReadyCheck;
  signedIn?: boolean;
};

export type BuildConfig = {
  command: string;
  output: string;
  forbid?: (string | RegExp)[];
};

export type VoiceConfig = {
  name?: string;
  speed?: number;
  saidAs?: [RegExp, string][];
};

export type DemoConfig<Server = unknown> = {
  name: string;
  site?: string;
  build?: BuildConfig;
  stage?: { width: number; height: number };
  clock?: { anchor?: string; timezone: string; locale?: string };
  themes?: Theme[];
  storage?: (
    theme: Theme,
    overrides?: Record<string, unknown>
  ) => Record<string, string>;
  entries: Record<string, EntryConfig> & { app: EntryConfig };
  mock?: (page: Page, ctx: MockContext) => Promise<Server>;
  voice?: VoiceConfig;
  tour?: string[];
};

export type Preferences = Record<string, unknown>;

export type SceneOptions = {
  title: string;
  blurb: string;
  ref?: string;
  entry?: string;
  path?: string;
  reference?: Date;
  preferences?: Preferences;
};

export type GapBucket = {
  label: string;
  count: number;
};

export type ClipMetrics = {
  frames: number;
  seconds: number;
  measured: number;
  worstGapMs: number;
  motionSeconds: number;
  motionGaps: number;
  gapHistogram: GapBucket[];
  mp4: string;
  webm: string | null;
  poster: string;
  spoken: number;
  overrunSeconds: number;
};

export type SceneEntry = SceneOptions & {
  scene: string;
  theme: Theme;
  stills: string[];
  clip: ClipMetrics;
};

export function defineDemo<Server = unknown>(
  config: DemoConfig<Server>
): DemoConfig<Server> {
  return config;
}
