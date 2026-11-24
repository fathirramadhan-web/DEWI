import type { Locator, Page } from '@playwright/test';

import type { CameraView } from './overlay.ts';
import { estimateSpeechMs } from './voice.ts';

const FRAME_MS = 1000 / 60;

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type Point = { x: number; y: number };
export type Target = Locator | Point | string;

function formatKeyCombo(combo: string): string {
  const map: Record<string, string> = {
    Meta: '⌘',
    Control: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
    Enter: '↵',
    Escape: 'Esc',
    Backspace: '⌫',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    Period: '.',
    Comma: ',',
    Slash: '/',
    Backslash: '\\',
  };

  return combo
    .split('+')
    .map((part) => map[part] ?? part.toUpperCase())
    .join('+');
}

export class Actor {
  private cursor: Point = { x: 120, y: 120 };
  private view: CameraView = { tx: 0, ty: 0, scale: 1 };
  private pendingRelease: { ms?: number } | null = null;
  private zoomed = false;
  private focalSubject: Point | null = null;
  private stageWidth = 1920;
  private stageHeight = 1080;

  onNarrate?: (text: string) => void;
  onMotion?: (state: 'start' | 'end') => void;

  constructor(private readonly page: Page) {}

  get pointer(): Point {
    return { ...this.cursor };
  }

  private resolveTarget(target: Target): Locator | Point {
    return typeof target === 'string' ? this.page.getByTestId(target) : target;
  }

  private inViewport(pt: Point): boolean {
    return (
      pt.x >= 0 &&
      pt.x <= this.stageWidth &&
      pt.y >= 0 &&
      pt.y <= this.stageHeight
    );
  }

  private async measurePoint(
    target: Target,
    offset: Point | 'center' = 'center'
  ): Promise<Point> {
    const resolved = this.resolveTarget(target);
    if (!('boundingBox' in resolved)) {
      return resolved;
    }

    await resolved.first().waitFor({ state: 'visible' });
    const box = await resolved.first().boundingBox();
    if (!box) {
      throw new Error('Target element has no bounding box');
    }

    if (offset === 'center') {
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    return { x: box.x + offset.x, y: box.y + offset.y };
  }

  private async measureBox(target: Target) {
    const resolved = this.resolveTarget(target);
    if (!('boundingBox' in resolved)) {
      return { x: resolved.x, y: resolved.y, width: 0, height: 0 };
    }
    await resolved.first().waitFor({ state: 'visible' });
    return resolved.first().boundingBox();
  }

  private toScreen(pt: Point): Point {
    return {
      x: this.view.tx + this.view.scale * pt.x,
      y: this.view.ty + this.view.scale * pt.y,
    };
  }

  private toApp(pt: Point): Point {
    return {
      x: (pt.x - this.view.tx) / this.view.scale,
      y: (pt.y - this.view.ty) / this.view.scale,
    };
  }

  async measureStage(): Promise<void> {
    const dims = await this.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    this.stageWidth = dims.width;
    this.stageHeight = dims.height;
  }

  async where(
    target: Target,
    offset: Point | 'center' = 'center'
  ): Promise<Point> {
    const point = await this.measurePoint(target, offset);
    if (!this.pendingRelease || this.inViewport(point)) {
      return point;
    }
    await this.release();
    return this.measurePoint(target, offset);
  }

  async moveTo(dest: Point, durationMs?: number): Promise<void> {
    const origin = this.cursor;
    const dx = dest.x - origin.x;
    const dy = dest.y - origin.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) {
      return;
    }

    const span = durationMs ?? Math.min(980, Math.max(260, 230 + dist * 0.62));
    const steps = Math.max(2, Math.round(span / FRAME_MS));
    const started = performance.now();

    this.onMotion?.('start');
    try {
      for (let step = 1; step <= steps; step += 1) {
        const eased = smootherstep(step / steps);
        const x = origin.x + dx * eased;
        const y = origin.y + dy * eased;
        await this.page.mouse.move(x, y);
        this.cursor = { x, y };

        const targetTime = started + (span * step) / steps;
        const remaining = targetTime - performance.now();
        if (remaining > 1) {
          await waitMs(remaining);
        }
      }
      this.cursor = { ...dest };
      await this.page.mouse.move(dest.x, dest.y);
    } finally {
      this.onMotion?.('end');
    }
  }

  async to(
    target: Target,
    options: { ms?: number; at?: Point } = {}
  ): Promise<Point> {
    const pt = await this.where(target, options.at ?? 'center');
    await this.moveTo(pt, options.ms);
    return pt;
  }

  async hover(target: Target, holdMs = 420): Promise<void> {
    await this.to(target);
    await this.beat(holdMs);
  }

  async click(
    target: Target,
    options: { before?: number; after?: number; at?: Point } = {}
  ): Promise<void> {
    await this.to(target, { at: options.at });
    await this.beat(options.before ?? 180);

    const refreshed = await this.where(target, options.at ?? 'center').catch(
      () => null
    );
    if (
      refreshed &&
      Math.hypot(refreshed.x - this.cursor.x, refreshed.y - this.cursor.y) > 3
    ) {
      await this.moveTo(refreshed, 220);
    }

    await this.page.mouse.down();
    await this.beat(90);
    await this.page.mouse.up();
    await this.beat(options.after ?? 340);
  }

  async dragTo(
    from: Target,
    to: Target,
    options: { ms?: number; fromAt?: Point; toAt?: Point; hold?: number } = {}
  ): Promise<void> {
    await this.unzoomForGesture();
    const start = await this.where(from, options.fromAt ?? 'center');
    await this.moveTo(start);
    await this.beat(220);

    await this.page.mouse.down();
    await this.setDragIndicator(true);
    await this.beat(options.hold ?? 160);

    await this.moveTo({ x: start.x + 6, y: start.y + 6 }, 90);

    const end = await this.where(to, options.toAt ?? 'center');
    await this.moveTo(end, options.ms ?? 780);
    await this.beat(220);

    await this.page.mouse.up();
    await this.setDragIndicator(false);
    await this.beat(380);
  }

  async scroll(target: Target, deltaY: number, durationMs = 700): Promise<void> {
    await this.unzoomForGesture();
    await this.to(target);
    const steps = Math.max(2, Math.round(durationMs / FRAME_MS));
    let sent = 0;

    this.onMotion?.('start');
    try {
      for (let step = 1; step <= steps; step += 1) {
        const eased = smootherstep(step / steps) * deltaY;
        const delta = eased - sent;
        sent = eased;
        await this.page.mouse.wheel(0, delta);
        await waitMs(FRAME_MS);
      }
    } finally {
      this.onMotion?.('end');
    }

    await this.beat(260);
  }

  async press(
    combo: string,
    options: { lead?: number; after?: number } = {}
  ): Promise<void> {
    await this.keys(formatKeyCombo(combo));
    await this.beat(options.lead ?? 440);
    await this.page.keyboard.press(combo);
    await this.beat(options.after ?? 520);
    await this.keys(null);
  }

  async type(text: string, perCharMs = 58): Promise<void> {
    for (let idx = 0; idx < text.length; idx += 1) {
      await this.page.keyboard.type(text[idx]!);
      const jitter = ((idx * 37) % 11) - 5;
      await waitMs(Math.max(18, perCharMs + jitter));
    }
  }

  async say(text: string | null, holdMs = 0): Promise<void> {
    if (!text) {
      if (holdMs) {
        await this.beat(holdMs);
      }
      return;
    }

    await this.release();
    this.onNarrate?.(text);
    await this.beat(estimateSpeechMs(text, holdMs));
  }

  private isAlreadyFramed(subject: Point, scale: number): boolean {
    if (Math.abs(this.view.scale - scale) > 0.25) {
      return false;
    }
    const screen = this.toScreen(subject);
    const margin = 0.2;
    return (
      screen.x > this.stageWidth * margin &&
      screen.x < this.stageWidth * (1 - margin) &&
      screen.y > this.stageHeight * margin &&
      screen.y < this.stageHeight * (1 - margin)
    );
  }

  async focus(
    target: Target,
    options: { scale?: number; ms?: number; point?: boolean } = {}
  ): Promise<void> {
    const scale = options.scale ?? 1.5;
    const ms = options.ms ?? 1150;

    const box = await this.measureBox(target);
    if (!box) {
      return;
    }

    this.pendingRelease = null;

    const subject = this.toApp({
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
    const restApp = this.toApp({
      x: box.x + Math.min(box.width * 0.08, 46),
      y: box.y + box.height / 2,
    });

    if (this.isAlreadyFramed(subject, scale)) {
      if (options.point !== false) {
        await this.moveTo(this.toScreen(restApp), 620);
      }
      return;
    }

    const nextView = await this.page.evaluate(
      (params) =>
        window.__dewi?.zoom(
          params.x,
          params.y,
          params.scale,
          params.ms
        ),
      { ...subject, scale, ms }
    );
    if (nextView) {
      this.view = nextView;
    }
    this.zoomed = scale !== 1;
    this.focalSubject = subject;

    this.onMotion?.('start');
    try {
      if (options.point === false) {
        await this.beat(ms + 40);
        return;
      }
      await Promise.all([
        this.moveTo(this.toScreen(restApp), Math.min(ms, 900)),
        this.beat(ms + 40),
      ]);
    } finally {
      this.onMotion?.('end');
    }
  }

  async unfocus(options: { ms?: number } = {}): Promise<void> {
    if (!this.zoomed) {
      return;
    }
    this.pendingRelease = options;
  }

  async wideForStill(): Promise<() => Promise<void>> {
    if (!this.pendingRelease || !this.zoomed) {
      return async () => {};
    }

    const saved = this.view;
    await this.page.evaluate(() => window.__dewi?.setInstantView(0, 0, 1));

    return async () => {
      await this.page.evaluate(
        (v) => window.__dewi?.setInstantView(v.tx, v.ty, v.scale),
        saved
      );
    };
  }

  async release(): Promise<void> {
    const pending = this.pendingRelease;
    this.pendingRelease = null;
    if (!pending || !this.zoomed) {
      return;
    }
    await this.widen(pending.ms ?? 950);
  }

  private async widen(ms: number): Promise<void> {
    const nextView = await this.page.evaluate(
      (duration) => window.__dewi?.zoom(0, 0, 1, duration),
      ms
    );
    this.view = nextView ?? { tx: 0, ty: 0, scale: 1 };
    this.zoomed = false;
    this.pendingRelease = null;

    const subject = this.focalSubject;
    this.focalSubject = null;

    this.onMotion?.('start');
    try {
      if (subject) {
        await Promise.all([
          this.moveTo(this.toScreen(subject), Math.min(ms, 800)),
          this.beat(ms + 40),
        ]);
        return;
      }
      await this.beat(ms + 40);
    } finally {
      this.onMotion?.('end');
    }
  }

  private async unzoomForGesture(): Promise<void> {
    this.pendingRelease = null;
    if (this.zoomed) {
      await this.widen(600);
    }
  }

  async spotlight(
    target: Target,
    text: string,
    options: {
      scale?: number;
      hold?: number;
      stay?: boolean;
      point?: boolean;
    } = {}
  ): Promise<void> {
    this.onNarrate?.(text);
    const started = Date.now();

    await this.focus(target, {
      scale: options.scale,
      point: options.point,
    });

    const elapsed = Date.now() - started;
    const totalHold = estimateSpeechMs(text, options.hold ?? 0);
    await this.beat(Math.max(0, totalHold - elapsed));

    if (!options.stay) {
      await this.unfocus();
    }
  }

  async keys(combo: string | null): Promise<void> {
    await this.page.evaluate(
      (label) => window.__dewi?.keys(label),
      combo
    );
  }

  private async setDragIndicator(active: boolean): Promise<void> {
    await this.page.evaluate(
      (on) => window.__dewi?.drag(on),
      active
    );
  }

  async overlay(visible: boolean): Promise<void> {
    await this.page.evaluate(
      (on) => window.__dewi?.visible(on),
      visible
    );
  }

  async beat(ms: number): Promise<void> {
    await waitMs(ms);
  }

  async settle(timeoutMs = 1200): Promise<void> {
    await this.page
      .waitForFunction(
        () =>
          document
            .getAnimations()
            .every((anim) => anim.playState !== 'running'),
        undefined,
        { timeout: timeoutMs }
      )
      .catch(() => undefined);

    await this.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })
    );
  }
}
