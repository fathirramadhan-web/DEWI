import { expect } from '@playwright/test';

import type { ReadyCheck } from './types.ts';

export function visible(testId: string): ReadyCheck {
  return async (page) => {
    await expect(page.getByTestId(testId)).toBeVisible();
  };
}

export function attribute(testId: string, attr: string, expected: string): ReadyCheck {
  return async (page) => {
    await expect(page.getByTestId(testId)).toHaveAttribute(attr, expected);
  };
}

export function textContent(testId: string, pattern: string | RegExp): ReadyCheck {
  return async (page) => {
    await expect(page.getByTestId(testId)).toContainText(pattern);
  };
}

export function tallerThan(testId: string, minPx: number): ReadyCheck {
  return async (page) => {
    await expect
      .poll(async () => (await page.getByTestId(testId).boundingBox())?.height ?? 0)
      .toBeGreaterThan(minPx);
  };
}

export function widerThan(testId: string, minPx: number): ReadyCheck {
  return async (page) => {
    await expect
      .poll(async () => (await page.getByTestId(testId).boundingBox())?.width ?? 0)
      .toBeGreaterThan(minPx);
  };
}

export function networkIdle(): ReadyCheck {
  return async (page) => {
    await page.waitForLoadState('networkidle');
  };
}

export function allChecks(...checks: ReadyCheck[]): ReadyCheck {
  return async (page) => {
    for (const check of checks) {
      await check(page);
    }
  };
}

export const immediate: ReadyCheck = async () => {};
