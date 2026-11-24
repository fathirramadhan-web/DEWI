#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { APP_ROOT, PROJECT, SITE, demo } from './config.ts';

if (SITE) {
  process.stdout.write(`demo: filming live site ${SITE}, skipping build\n`);
  process.exit(0);
}

const buildConfig = demo.build!;
const PINNED_DIR = join(PROJECT, '.build');
const OUTPUT_DIR = join(APP_ROOT, buildConfig.output);

function execShell(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: APP_ROOT,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`build exited ${code}`))
    );
  });
}

async function listJsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return listJsFiles(full);
      }
      return entry.name.endsWith('.js') || entry.name.endsWith('.mjs')
        ? [full]
        : [];
    })
  );
  return nested.flat();
}

process.stdout.write(`demo: building (${buildConfig.command})\n`);
await execShell(buildConfig.command);

const indexStat = await stat(join(OUTPUT_DIR, 'index.html')).catch(() => null);
if (!indexStat) {
  process.stderr.write(
    `demo: build finished but ${OUTPUT_DIR} has no index.html.\n` +
      '      verify build.output in demo.config.ts.\n'
  );
  process.exit(1);
}

await rm(PINNED_DIR, { recursive: true, force: true });
await cp(OUTPUT_DIR, PINNED_DIR, { recursive: true });

const jsFiles = await listJsFiles(PINNED_DIR);
const bundles = await Promise.all(
  jsFiles.map(async (file) => ({
    file,
    text: await readFile(file, 'utf8').catch(() => ''),
  }))
);

const matchesRule = (rule: string | RegExp, text: string): boolean =>
  typeof rule === 'string' ? text.includes(rule) : rule.test(text);

for (const rule of buildConfig.forbid ?? []) {
  const hit = bundles.find((bundle) => matchesRule(rule, bundle.text));
  if (hit) {
    process.stderr.write(
      `demo: pinned build matched forbidden rule: ${String(rule)}\n` +
        `      file: ${relative(PINNED_DIR, hit.file)}\n` +
        '      check API base URL or env configuration before filming.\n'
    );
    process.exit(1);
  }
}

process.stdout.write(`demo: pinned build at ${PINNED_DIR}\n`);
