import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import {
  BASE_URL,
  ENGINE_DIR,
  LOCALE,
  OUT_DIR,
  PORT,
  PROJECT,
  SITE,
  STAGE,
  STILL_SCALE,
  THEMES,
  TZ,
  VIDEO_SCALE,
  WORKERS,
} from './config.ts';

process.env.TZ = TZ;

export default defineConfig({
  testDir: join(PROJECT, 'scenes'),
  testMatch: '**/*.scene.ts',
  outputDir: join(OUT_DIR, '.pw-results'),
  fullyParallel: true,
  workers: WORKERS,
  retries: 0,
  timeout: 4 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    timezoneId: TZ,
    locale: LOCALE,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    viewport: { width: STAGE.width, height: STAGE.height },
    deviceScaleFactor: STILL_SCALE,
    launchOptions: {
      args: [
        `--force-device-scale-factor=${VIDEO_SCALE}`,
        '--disable-gpu-vsync',
        '--disable-frame-rate-limit',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
        '--hide-scrollbars',
      ],
    },
  },
  projects: THEMES.map((theme) => ({
    name: theme,
    use: {
      ...devices['Desktop Chrome'],
      colorScheme: theme,
      viewport: { width: STAGE.width, height: STAGE.height },
      deviceScaleFactor: STILL_SCALE,
    },
  })),
  globalSetup: './run-id.ts',
  globalTeardown: './stitch.ts',
  webServer: SITE
    ? undefined
    : {
        command: `"${process.execPath}" "${join(ENGINE_DIR, 'serve.ts')}" "${join(PROJECT, '.build')}" ${PORT}`,
        url: BASE_URL,
        cwd: PROJECT,
        reuseExistingServer: false,
        stdout: 'ignore',
        stderr: 'pipe',
        timeout: 60_000,
      },
});
