#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORKSPACES_HOME = join(homedir(), '.dewi');

function printUsage(exitCode = 0) {
  process.stdout.write(`dewi <command> [options] — Demo Engine for Web Interaction

Commands:
  doctor                        Check Node, ffmpeg, Playwright Chromium, and voice backends
  init <appRoot | --site url>   Create a demo workspace (use --project <dir> to place locally)
  run [--project <dir>] [...]   Build (if needed) and record scenes with Playwright + ffmpeg
  gaps [manifestOrDir]          Audit frame-gap histograms in manifest.json
  probe-fps                     Benchmark raw CDP screencast throughput at 1080p/1440p/4K
`);
  process.exit(exitCode);
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`${cmd} killed by ${signal}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

function captureCommand(cmd, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', () => resolvePromise({ ok: false, stdout: '', stderr: '' }));
    child.on('close', (code) =>
      resolvePromise({ ok: code === 0, stdout, stderr })
    );
  });
}

function playwrightCacheRoots() {
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'ms-playwright')
      : null,
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright'),
  ].filter(Boolean);
}

function findChromiumBinary() {
  if (process.env.DEMO_CHROMIUM_PATH) {
    return process.env.DEMO_CHROMIUM_PATH;
  }

  const candidates = [
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-linux/chrome',
    'chrome-linux64/chrome',
  ];

  for (const root of playwrightCacheRoots()) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root)
      .filter((name) => name.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const dir of dirs) {
      for (const rel of candidates) {
        const full = join(root, dir, rel);
        if (existsSync(full)) return full;
      }
    }
  }
  return null;
}

async function cmdDoctor() {
  let fatal = false;
  const ok = (msg) => process.stdout.write(`  ok    ${msg}\n`);
  const warn = (msg, fix) =>
    process.stdout.write(`  warn  ${msg}\n        fix: ${fix}\n`);
  const fail = (msg, fix) => {
    fatal = true;
    process.stdout.write(`  fail  ${msg}\n        fix: ${fix}\n`);
  };

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 18)) {
    ok(`node v${process.versions.node}`);
  } else {
    fail(
      `node v${process.versions.node} is older than 22.18`,
      'Install Node.js >= 22.18'
    );
  }

  ok(`platform ${platform()} (${process.arch})`);

  const ff = await captureCommand('ffmpeg', ['-version']);
  if (ff.ok) {
    ok(ff.stdout.split(/\r?\n/)[0] ?? 'ffmpeg installed');
    const enc = await captureCommand('ffmpeg', ['-hide_banner', '-encoders']);
    if (platform() === 'darwin' && enc.stdout.includes('h264_videotoolbox')) {
      ok('encoder: h264_videotoolbox');
    } else if (enc.stdout.includes('libx264')) {
      ok('encoder: libx264');
    } else {
      fail('ffmpeg lacks libx264 / h264_videotoolbox', 'Install full ffmpeg build');
    }
  } else {
    fail('ffmpeg not found on PATH', 'Install ffmpeg and add to PATH');
  }

  const chromium = findChromiumBinary();
  if (chromium) {
    ok(`playwright chromium (${chromium})`);
  } else {
    fail(
      'playwright chromium not found',
      'Run: npx playwright install chromium'
    );
  }

  const hasPlaywrightPkg = existsSync(
    join(STUDIO_ROOT, 'node_modules', '@playwright', 'test')
  );
  if (hasPlaywrightPkg) {
    ok('npm dependencies installed');
  } else {
    fail('node_modules missing', `Run npm install in ${STUDIO_ROOT}`);
  }

  const voiceHome =
    process.env.DEMO_VOICE_HOME ?? join(homedir(), '.cache', 'demo-voice');
  const hasKokoro =
    (existsSync(join(voiceHome, '.venv', 'Scripts', 'python.exe')) ||
      existsSync(join(voiceHome, '.venv', 'bin', 'python'))) &&
    existsSync(join(voiceHome, 'kokoro.onnx')) &&
    existsSync(join(voiceHome, 'voices.bin'));

  if (hasKokoro) {
    ok(`voice backend: Kokoro ONNX (${voiceHome})`);
  } else if (platform() === 'win32') {
    ok('voice backend: Windows offline SAPI (built-in fallback)');
  } else {
    warn(
      'no local voice backend installed (will record silent)',
      'Install Kokoro ONNX or pass DEMO_VOICE=0'
    );
  }

  process.exit(fatal ? 1 : 0);
}

async function linkDir(linkPath, targetPath) {
  const type = platform() === 'win32' ? 'junction' : 'dir';
  await symlink(targetPath, linkPath, type).catch((err) => {
    if (err.code !== 'EEXIST') throw err;
  });
}

async function cmdInit(args) {
  let site = null;
  let customProject = null;
  let target = null;
  let force = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--site') {
      site = args[++i];
    } else if (arg.startsWith('--site=')) {
      site = arg.slice('--site='.length);
    } else if (arg === '--project') {
      customProject = args[++i];
    } else if (arg.startsWith('--project=')) {
      customProject = arg.slice('--project='.length);
    } else if (arg === '--force') {
      force = true;
    } else if (!arg.startsWith('-')) {
      target = arg;
    }
  }

  if (!site && !target) {
    process.stderr.write(
      'Usage: dewi init <appRoot> | --site <url> [--project <dir>] [--force]\n'
    );
    process.exit(1);
  }

  const appRoot = target ? resolve(target) : null;
  if (appRoot) {
    const info = await stat(appRoot).catch(() => null);
    if (!info?.isDirectory()) {
      process.stderr.write(`init: ${appRoot} is not a directory\n`);
      process.exit(1);
    }
  }

  let key;
  if (site) {
    key = new URL(site).host.replace(/[^a-zA-Z0-9._-]+/g, '-');
  } else {
    const pkgRaw = await readFile(join(appRoot, 'package.json'), 'utf8').catch(
      () => null
    );
    const pkgName = pkgRaw ? JSON.parse(pkgRaw).name : null;
    key = (pkgName ?? basename(appRoot))
      .replace(/^@/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  const project = customProject
    ? resolve(customProject)
    : join(WORKSPACES_HOME, key);

  await mkdir(join(project, 'scenes'), { recursive: true });
  const existing = await readdir(project).catch(() => []);
  const keepConfig = existing.includes('demo.config.ts') && !force;

  if (!keepConfig) {
    if (site) {
      const parsed = new URL(site);
      await writeFile(
        join(project, 'demo.config.ts'),
        `import { defineDemo } from 'dewi/define';
import { networkIdle } from 'dewi/ready';

export default defineDemo({
  name: '${key}',
  site: '${parsed.origin}',
  clock: { timezone: 'UTC', locale: 'en-US' },
  themes: ['dark'],
  entries: {
    app: {
      path: '${parsed.pathname}${parsed.search}${parsed.hash}',
      ready: networkIdle(),
    },
  },
});
`
      );
    } else {
      await writeFile(
        join(project, 'demo.config.ts'),
        `import { defineDemo } from 'dewi/define';
import { visible } from 'dewi/ready';

export default defineDemo({
  name: '${key}',
  build: {
    command: 'npm run build',
    output: 'dist',
    forbid: [],
  },
  stage: { width: 1920, height: 1080 },
  clock: {
    anchor: '2026-09-16T09:00:00.000Z',
    timezone: 'UTC',
    locale: 'en-US',
  },
  themes: ['dark'],
  entries: {
    app: {
      path: '/',
      ready: visible('app-root'),
    },
  },
  mock: (page, ctx) => import('./mock.ts').then((m) => m.mock(page, ctx)),
  tour: ['smoke'],
});
`
      );
      await writeFile(
        join(project, 'mock.ts'),
        `import type { Page } from '@playwright/test';
import type { MockContext } from 'dewi/define';

export async function mock(page: Page, _ctx: MockContext): Promise<unknown> {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    })
  );
  return {};
}
`
      );
    }

    await writeFile(
      join(project, 'scenes', 'smoke.scene.ts'),
      `import { scene } from 'dewi/scene';

scene(
  'smoke',
  {
    title: 'Smoke test',
    blurb: 'Verifies capture, cursor overlay, and voice-over pipeline.',
  },
  async ({ actor, shot }) => {
    await actor.beat(400);
    await actor.say('This is a recorded smoke test running locally.');
    await shot();
  }
);
`
    );
  }

  await writeFile(
    join(project, 'package.json'),
    `${JSON.stringify({ name: `demo-${key}`, private: true, type: 'module' }, null, 2)}\n`
  );

  await writeFile(
    join(project, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          types: ['node'],
          paths: {
            'dewi/*': [join(STUDIO_ROOT, 'src/*').replace(/\\/g, '/')],
          },
        },
        include: ['**/*.ts'],
        exclude: ['node_modules', '.build', 'demo-out'],
      },
      null,
      2
    )}\n`
  );

  const nmDir = join(project, 'node_modules');
  await mkdir(nmDir, { recursive: true });
  await linkDir(join(nmDir, 'dewi'), STUDIO_ROOT);
  await linkDir(
    join(nmDir, '@playwright'),
    join(STUDIO_ROOT, 'node_modules', '@playwright')
  );

  if (appRoot) {
    const appNm = join(appRoot, 'node_modules');
    const entries = await readdir(appNm).catch(() => []);
    for (const name of entries) {
      if (name === '.bin' || name === 'dewi' || name === '@playwright') {
        continue;
      }
      const dest = join(nmDir, name);
      if (existsSync(dest)) continue;
      const real = await realpath(join(appNm, name)).catch(() =>
        join(appNm, name)
      );
      await linkDir(dest, real);
    }
    await writeFile(
      join(project, '.origin'),
      `${JSON.stringify({ appRoot }, null, 2)}\n`
    );
  }

  process.stdout.write(`init: ready at ${project}\n`);
}

async function resolveWorkspace(askedProject) {
  if (askedProject) return resolve(askedProject);
  if (process.env.DEMO_PROJECT) return resolve(process.env.DEMO_PROJECT);

  const cwd = resolve(process.cwd());
  if (existsSync(join(cwd, 'demo.config.ts'))) {
    return cwd;
  }

  const names = await readdir(WORKSPACES_HOME).catch(() => []);
  for (const name of names) {
    const originRaw = await readFile(
      join(WORKSPACES_HOME, name, '.origin'),
      'utf8'
    ).catch(() => null);
    if (!originRaw) continue;
    const appRoot = resolve(JSON.parse(originRaw).appRoot);
    if (
      cwd === appRoot ||
      cwd.toLowerCase().startsWith(`${appRoot.toLowerCase()}\\`) ||
      cwd.toLowerCase().startsWith(`${appRoot.toLowerCase()}/`)
    ) {
      return join(WORKSPACES_HOME, name);
    }
  }

  throw new Error(
    `No workspace found for ${cwd}. Pass --project <dir> or run init first.`
  );
}

async function cmdRun(args) {
  let askedProject = null;
  const forwarded = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') continue;
    if (arg === '--project') {
      askedProject = args[++i];
    } else if (arg.startsWith('--project=')) {
      askedProject = arg.slice('--project='.length);
    } else {
      forwarded.push(arg);
    }
  }

  const project = await resolveWorkspace(askedProject);
  const configPath = join(project, 'demo.config.ts');
  const originRaw = await readFile(join(project, '.origin'), 'utf8').catch(
    () => null
  );
  const appRoot = originRaw ? JSON.parse(originRaw).appRoot : null;

  process.env.DEMO_CONFIG = configPath;
  process.env.DEMO_PROJECT = project;
  if (appRoot) {
    process.env.DEMO_APP_ROOT = appRoot;
  }

  const { SITE } = await import(
    new URL(`file:///${join(STUDIO_ROOT, 'src', 'config.ts').replace(/\\/g, '/')}`).href
  );

  if (!SITE && process.env.DEMO_BUILD !== '0') {
    const code = await runCommand(process.execPath, [
      join(STUDIO_ROOT, 'src', 'pin-build.ts'),
    ]);
    if (code !== 0) process.exit(code);
  }

  const pwCli = join(
    STUDIO_ROOT,
    'node_modules',
    '@playwright',
    'test',
    'cli.js'
  );
  const pwConfig = join(STUDIO_ROOT, 'src', 'playwright.config.ts');
  const exitCode = await runCommand(process.execPath, [
    pwCli,
    'test',
    `--config=${pwConfig}`,
    ...forwarded,
  ]);
  process.exit(exitCode);
}

async function cmdGaps(args) {
  const target = resolve(args[0] ?? process.env.DEMO_OUT ?? join(process.cwd(), 'demo-out'));
  const manifestPath = target.endsWith('.json')
    ? target
    : join(target, 'manifest.json');
  const slowShareLimit = Number(process.env.DEMO_SLOW_SHARE ?? 0.25);
  const motionFloor = Number(process.env.DEMO_MOTION_FLOOR ?? 1);

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const rows = [];
  for (const sc of manifest.scenes ?? []) {
    for (const [theme, asset] of Object.entries(sc.assets ?? {})) {
      rows.push({ scene: sc.scene, theme, asset });
    }
  }

  if (rows.length === 0) {
    process.stdout.write(`gaps: no clips in ${manifestPath}\n`);
    return;
  }

  let hasJank = false;
  for (const { scene, theme, asset } of rows) {
    const label = `${theme}/${scene}`.padEnd(28);
    if (
      asset.motionSeconds !== undefined &&
      asset.motionSeconds < motionFloor
    ) {
      process.stdout.write(
        `  ${label} held (${asset.motionSeconds}s motion, skipped)\n`
      );
      continue;
    }

    const hist = asset.gaps ?? [];
    const total = hist.reduce((s, b) => s + b.count, 0);
    const over50 = hist
      .filter((b) => {
        if (/slower/i.test(b.label)) return true;
        const m = b.label.match(/(\d+(?:\.\d+)?)\s*ms/);
        return m ? Number(m[1]) > 50 : true;
      })
      .reduce((s, b) => s + b.count, 0);
    const share = total > 0 ? over50 / total : 0;
    const jank = share > slowShareLimit;
    if (jank) hasJank = true;

    const line = hist.map((b) => `${b.label}: ${b.count}`).join('  ');
    process.stdout.write(
      `${jank ? '!' : ' '} ${label} ${String(asset.fps).padStart(5)}fps  ${line}\n`
    );
  }

  if (hasJank) {
    process.stderr.write(
      `\ngaps: one or more clips exceeded ${Math.round(slowShareLimit * 100)}% slow gaps (>50ms)\n`
    );
    process.exit(1);
  }
  process.stdout.write('\n  all motion clips within gap budget.\n');
}

async function cmdProbeFps() {
  const execPath = findChromiumBinary();
  if (!execPath) {
    process.stderr.write('probe-fps: Chromium not found. Run npx playwright install chromium\n');
    process.exit(1);
  }

  const seconds = Number(process.env.DEMO_PROBE_SECONDS ?? 4);
  const html = `<!doctype html><html><body style="margin:0;overflow:hidden;background:#0f172a">
<div id="box" style="position:fixed;top:40%;left:0;width:120px;height:120px;border-radius:16px;background:linear-gradient(135deg,#38bdf8,#818cf8)"></div>
<script>
const box = document.getElementById('box');
function tick(t) {
  const w = window.innerWidth - 120;
  const x = (Math.sin(t / 500) * 0.5 + 0.5) * w;
  box.style.transform = 'translate(' + x.toFixed(2) + 'px,0)';
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
</script></body></html>`;

  const stages = [
    { label: '1080p', width: 1920, height: 1080 },
    { label: '1440p', width: 2560, height: 1440 },
    { label: '4K', width: 3840, height: 2160 },
  ];

  process.stdout.write(`probe-fps: ${execPath}\n\n`);
  for (const stage of stages) {
    const child = spawn(
      execPath,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        '--disable-gpu-vsync',
        '--disable-frame-rate-limit',
        `--window-size=${stage.width},${stage.height}`,
        '--force-device-scale-factor=1',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    const wsUrl = await new Promise((resolveUrl, rejectUrl) => {
      let buf = '';
      const timer = setTimeout(
        () => rejectUrl(new Error('DevTools WebSocket timeout')),
        10_000
      );
      child.stderr.on('data', (chunk) => {
        buf += chunk.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolveUrl(m[1]);
        }
      });
    });

    const ws = new WebSocket(wsUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let msgId = 1;
    const pending = new Map();
    const frames = [];
    let sid = null;

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method === 'Page.screencastFrame' && msg.sessionId === sid) {
        frames.push(msg.params.metadata?.timestamp ?? Date.now() / 1000);
        ws.send(
          JSON.stringify({
            id: msgId++,
            method: 'Page.screencastFrameAck',
            params: { sessionId: msg.params.sessionId },
            sessionId: sid,
          })
        );
      }
    });

    const sendCdp = (method, params = {}, sessionId) =>
      new Promise((r) => {
        const id = msgId++;
        pending.set(id, r);
        ws.send(
          JSON.stringify(
            sessionId ? { id, method, params, sessionId } : { id, method, params }
          )
        );
      });

    const target = await sendCdp('Target.createTarget', { url: 'about:blank' });
    const attached = await sendCdp('Target.attachToTarget', {
      targetId: target.result.targetId,
      flatten: true,
    });
    sid = attached.result.sessionId;

    await sendCdp('Page.enable', {}, sid);
    await sendCdp(
      'Emulation.setDeviceMetricsOverride',
      { width: stage.width, height: stage.height, deviceScaleFactor: 1, mobile: false },
      sid
    );
    await sendCdp(
      'Page.navigate',
      { url: `data:text/html,${encodeURIComponent(html)}` },
      sid
    );
    await new Promise((r) => setTimeout(r, 250));
    await sendCdp(
      'Page.startScreencast',
      { format: 'jpeg', quality: 80, everyNthFrame: 1 },
      sid
    );
    await new Promise((r) => setTimeout(r, seconds * 1000));
    await sendCdp('Page.stopScreencast', {}, sid);
    ws.close();
    child.kill();

    const gaps = frames
      .slice(1)
      .map((t, i) => t - frames[i])
      .filter((g) => g > 0 && g <= 0.05);
    const total = gaps.reduce((a, b) => a + b, 0);
    const fps = total > 0 ? gaps.length / total : 0;
    process.stdout.write(
      `  ${stage.label.padEnd(6)} ${stage.width}x${stage.height}  ${fps.toFixed(1).padStart(5)}fps  (${frames.length} frames in ${seconds}s)\n`
    );
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'doctor':
    await cmdDoctor();
    break;
  case 'init':
    await cmdInit(rest);
    break;
  case 'run':
    await cmdRun(rest);
    break;
  case 'gaps':
    await cmdGaps(rest);
    break;
  case 'probe-fps':
    await cmdProbeFps();
    break;
  default:
    printUsage(command ? 1 : 0);
}
