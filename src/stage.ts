import type { Page } from '@playwright/test';

import { Actor } from './actor.ts';
import type { ConfigServer } from './config.ts';
import { ANCHOR, PINNED, STAGE, TRACE_NAV, demo } from './config.ts';
import { installOverlay } from './overlay.ts';
import type { Preferences, Theme } from './types.ts';

export type StageOptions = {
  theme: Theme;
  entry?: string;
  path?: string;
  reference?: Date;
  preferences?: Preferences;
};

export type Stage = {
  page: Page;
  actor: Actor;
  server: ConfigServer;
};

export async function openStage(
  page: Page,
  options: StageOptions
): Promise<Stage> {
  const reference = options.reference ?? ANCHOR;
  const entryName = options.entry ?? 'app';
  const entry = demo.entries[entryName];
  if (!entry) {
    throw new Error(`demo.config.ts: unknown entry "${entryName}"`);
  }

  const signedIn = entry.signedIn ?? true;

  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: 'no-preference',
  });

  if (options.preferences && !demo.storage) {
    throw new Error(
      'Scene passed `preferences`, but demo.config.ts defines no `storage` serializer.'
    );
  }

  const initialStorage = demo.storage?.(options.theme, options.preferences) ?? {};
  await page.addInitScript((entries: Record<string, string>) => {
    for (const key of Object.keys(entries)) {
      try {
        localStorage.setItem(key, entries[key]!);
      } catch {
        // Ignore storage errors on restricted contexts
      }
    }
  }, initialStorage);

  if (TRACE_NAV) {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        process.stdout.write(`    nav  ${frame.url()}\n`);
      }
    });
    page.on('pageerror', (err) => {
      process.stdout.write(`    err  ${err.message.slice(0, 160)}\n`);
    });
  }

  await installOverlay(page);

  const server = (await demo.mock?.(page, {
    reference,
    entry: entryName,
    signedIn,
  })) as ConfigServer;

  if (PINNED) {
    await page.clock.setFixedTime(reference);
  }

  await page.goto(options.path ?? entry.path);
  await entry.ready(page);

  const actor = new Actor(page);
  await page.waitForFunction(() => Boolean(window.__dewi));
  await actor.measureStage();

  // Park cursor cleanly near the bottom-left corner so opening motion enters naturally.
  await actor.moveTo({ x: 64, y: STAGE.height - 56 }, 1);
  await actor.settle();

  return { page, actor, server };
}
