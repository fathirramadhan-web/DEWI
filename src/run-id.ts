import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { OUT_DIR } from './config.ts';

const RUN_ID_ENV = 'DEMO_RUN_ID';

export default function mintRunId(): void {
  process.env[RUN_ID_ENV] = randomBytes(6).toString('hex');
}

export function getRunId(): string {
  const existing = process.env[RUN_ID_ENV];
  if (existing) {
    return existing;
  }
  const generated = randomBytes(6).toString('hex');
  process.env[RUN_ID_ENV] = generated;
  return generated;
}

export function entryDir(): string {
  return join(OUT_DIR, '.entries', getRunId());
}
