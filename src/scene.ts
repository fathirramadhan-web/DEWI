import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Page } from '@playwright/test';
import { test } from '@playwright/test';

import type { Actor } from './actor.ts';
import type { ConfigServer } from './config.ts';
import { ANCHOR, FRAME_DIR, OUT_DIR, STAGE } from './config.ts';
import { ScreencastRecorder } from './recorder.ts';
import { entryDir } from './run-id.ts';
import { openStage } from './stage.ts';
import type { SceneEntry, SceneOptions, Theme } from './types.ts';

export type SceneContext = {
  page: Page;
  actor: Actor;
  theme: Theme;
  server: ConfigServer;
  shot: (label?: string) => Promise<void>;
};

export function scene(
  name: string,
  options: SceneOptions,
  body: (ctx: SceneContext) => Promise<void>
): void {
  test(name, async ({ page }, info) => {
    const theme = info.project.name as Theme;
    const themeDir = join(OUT_DIR, theme);
    const frameDir = join(FRAME_DIR, `${theme}-${name}`);

    await mkdir(themeDir, { recursive: true });
    await page.setViewportSize({ width: STAGE.width, height: STAGE.height });

    const stage = await openStage(page, {
      theme,
      entry: options.entry,
      path: options.path,
      reference: options.reference ?? ANCHOR,
      preferences: options.preferences,
    });

    const recorder = new ScreencastRecorder(page, frameDir);
    const stills: string[] = [];

    stage.actor.onNarrate = (text) => recorder.mark(text);
    stage.actor.onMotion = (state) => recorder.motion(state);

    const shot: SceneContext['shot'] = async (label) => {
      const fileName = label ? `${name}-${label}.png` : `${name}.png`;

      await recorder.pause();
      await stage.actor.overlay(false);

      const restoreView = await stage.actor.wideForStill();

      await stage.actor.settle();
      await page.screenshot({
        path: join(themeDir, fileName),
        animations: 'disabled',
      });
      stills.push(`${theme}/${fileName}`);

      await restoreView();
      await stage.actor.overlay(true);
      await recorder.resume();
      await stage.actor.beat(120);
    };

    await recorder.start();
    await stage.actor.beat(420);

    try {
      await body({
        page,
        actor: stage.actor,
        theme,
        server: stage.server,
        shot,
      });
    } catch (error) {
      await recorder.discard();
      throw error;
    }

    await stage.actor.unfocus();
    await stage.actor.release();
    await stage.actor.say(null);
    await stage.actor.beat(520);

    const clip = await recorder.stop(join(themeDir, name));

    const entry: SceneEntry = {
      ...options,
      scene: name,
      theme,
      stills,
      clip: {
        ...clip,
        mp4: `${theme}/${name}.mp4`,
        webm: clip.webm ? `${theme}/${name}.webm` : null,
        poster: `${theme}/${name}.poster.jpg`,
      },
    };

    const entries = entryDir();
    await mkdir(entries, { recursive: true });
    await writeFile(
      join(entries, `${theme}-${name}.json`),
      `${JSON.stringify(entry, null, 2)}\n`
    );

    info.annotations.push({
      type: 'capture',
      description:
        `${clip.frames} frames · ${clip.measured.toFixed(1)}fps · ` +
        `${clip.seconds.toFixed(1)}s · ${clip.spoken} spoken`,
    });
  });
}
