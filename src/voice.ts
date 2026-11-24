import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { VOICE_ENABLED, VOICE_MODE, demo } from './config.ts';

export type SpeechMark = { at: number; text: string };
export type SpokenLine = SpeechMark & { path: string; seconds: number };

const VOICE_HOME =
  process.env.DEMO_VOICE_HOME ?? join(homedir(), '.cache', 'demo-voice');
const PYTHON_CANDIDATES =
  platform() === 'win32'
    ? [
        join(VOICE_HOME, '.venv', 'Scripts', 'python.exe'),
        join(VOICE_HOME, '.venv', 'bin', 'python'),
      ]
    : [
        join(VOICE_HOME, '.venv', 'bin', 'python'),
        join(VOICE_HOME, '.venv', 'Scripts', 'python.exe'),
      ];
const KOKORO_MODEL = join(VOICE_HOME, 'kokoro.onnx');
const KOKORO_VOICES = join(VOICE_HOME, 'voices.bin');
const LINES_DIR = join(VOICE_HOME, 'lines');

const VOICE_NAME = process.env.DEMO_VOICE_NAME ?? demo.voice?.name ?? 'af_heart';
const VOICE_LANG = process.env.DEMO_VOICE_LANG ?? 'en-us';
const SPEED = Number(process.env.DEMO_VOICE_SPEED ?? demo.voice?.speed ?? 1);
const SENTENCE_PAUSE = Number(process.env.DEMO_VOICE_SENTENCE_PAUSE ?? 0.14);
const CLAUSE_PAUSE = Number(process.env.DEMO_VOICE_CLAUSE_PAUSE ?? 0.06);
const TARGET_RMS = Number(process.env.DEMO_VOICE_RMS ?? 0.12);

const BUILTIN_SAID_AS: [RegExp, string][] = [[/\blive\b/gi, 'liv']];
const PRONUNCIATIONS: [RegExp, string][] = [
  ...BUILTIN_SAID_AS,
  ...(demo.voice?.saidAs ?? []),
];

async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  );
}

async function findKokoroPython(): Promise<string | null> {
  for (const candidate of PYTHON_CANDIDATES) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function detectVoiceBackend(): Promise<'kokoro' | 'sapi' | 'none'> {
  if (!VOICE_ENABLED) {
    return 'none';
  }

  const py = await findKokoroPython();
  const hasKokoro =
    py !== null &&
    (await fileExists(KOKORO_MODEL)) &&
    (await fileExists(KOKORO_VOICES));

  if (VOICE_MODE === 'kokoro') {
    return hasKokoro ? 'kokoro' : 'none';
  }
  if (VOICE_MODE === 'sapi') {
    return platform() === 'win32' ? 'sapi' : 'none';
  }
  if (hasKokoro) {
    return 'kokoro';
  }
  if (platform() === 'win32') {
    return 'sapi';
  }
  return 'none';
}

export async function voiceReady(): Promise<boolean> {
  return (await detectVoiceBackend()) !== 'none';
}

export function voiceMissingMessage(): string {
  return (
    `  no voice-over backend ready (mode=${VOICE_MODE}).\n` +
    `  on Windows, built-in offline SAPI works automatically unless DEMO_VOICE=0.\n` +
    `  for Kokoro ONNX neural TTS (~350MB), install into ${VOICE_HOME}.\n`
  );
}

function applyPronunciations(text: string): string {
  return PRONUNCIATIONS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    text
  );
}

function cacheKey(backend: string, text: string, tag: string): string {
  return createHash('sha1')
    .update(
      `${backend}|${tag}|${VOICE_NAME}|${VOICE_LANG}|${SPEED}|${SENTENCE_PAUSE}|${CLAUSE_PAUSE}|${TARGET_RMS}|${text}`
    )
    .digest('hex')
    .slice(0, 16);
}

const KOKORO_SCRIPT = `
import json, sys, os
import numpy as np
import soundfile as sf

try:
    import espeakng_loader
    from phonemizer.backend.espeak.wrapper import EspeakWrapper
    EspeakWrapper.set_library(espeakng_loader.get_library_path())
    EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
except Exception:
    pass

from kokoro_onnx import Kokoro

job = json.load(sys.stdin)
kokoro = Kokoro(job["model"], job["voices"])

for line in job["lines"]:
    if os.path.exists(line["path"]):
        continue
    samples, rate = kokoro.create(
        line["text"],
        voice=job["voice"],
        speed=job["speed"],
        lang=job["lang"],
        sentence_pause=job["sentencePause"],
        clause_pause=job["clausePause"],
    )
    rms = float(np.sqrt(np.mean(samples ** 2)))
    if rms > 0:
        samples = samples * np.clip(job["targetRms"] / rms, 0.55, 1.6)
    sf.write(line["path"], samples, rate)

print(json.dumps({"ok": True}))
`;

function runKokoroPython(pythonBin: string, job: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ['-c', KOKORO_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`kokoro exited ${code}\n${stderr.slice(-800)}`))
    );
    child.stdin.end(JSON.stringify(job));
  });
}

function runWindowsSapi(
  lines: { text: string; path: string }[],
  speed: number,
  voiceName: string
): Promise<void> {
  // SAPI Rate accepts -10..10 where 0 is 1.0x speed.
  const sapiRate = Math.max(-10, Math.min(10, Math.round((speed - 1) * 6)));
  const payload = JSON.stringify({
    rate: sapiRate,
    voice: voiceName === 'af_heart' ? '' : voiceName,
    lines,
  });

  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$raw = [Console]::In.ReadToEnd()
$job = $raw | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = [int]$job.rate
if ($job.voice -and $job.voice.Trim().Length -gt 0) {
  $matched = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -like "*$($job.voice)*" } | Select-Object -First 1
  if ($matched) { $synth.SelectVoice($matched.VoiceInfo.Name) }
}
foreach ($item in $job.lines) {
  if (Test-Path $item.path) { continue }
  $synth.SetOutputToWaveFile($item.path)
  $synth.Speak($item.text)
  $synth.SetOutputToNull()
}
$synth.Dispose()
`;

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Windows SAPI exited ${code}\n${stderr.slice(-800)}`))
    );
    child.stdin.end(payload);
  });
}

async function normalizePcm16Wav(
  filePath: string,
  targetRms: number
): Promise<void> {
  const buf = await readFile(filePath);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    return;
  }

  let dataOffset = -1;
  let dataSize = 0;
  let bitsPerSample = 16;

  for (let pos = 12; pos + 8 <= buf.length; ) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && size >= 16 && pos + 8 + size <= buf.length) {
      bitsPerSample = buf.readUInt16LE(pos + 8 + 14);
    } else if (id === 'data') {
      dataOffset = pos + 8;
      dataSize = Math.min(size, buf.length - dataOffset);
      break;
    }
    pos += 8 + size + (size % 2);
  }

  if (dataOffset < 0 || bitsPerSample !== 16 || dataSize < 2) {
    return;
  }

  const sampleCount = Math.floor(dataSize / 2);
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = buf.readInt16LE(dataOffset + i * 2) / 32768;
    sumSq += sample * sample;
  }

  const rms = Math.sqrt(sumSq / sampleCount);
  if (rms <= 0) {
    return;
  }

  const gain = Math.min(1.8, Math.max(0.55, targetRms / rms));
  for (let i = 0; i < sampleCount; i += 1) {
    const scaled = Math.round(buf.readInt16LE(dataOffset + i * 2) * gain);
    const clamped = Math.max(-32768, Math.min(32767, scaled));
    buf.writeInt16LE(clamped, dataOffset + i * 2);
  }

  await writeFile(filePath, buf);
}

async function readWavSeconds(filePath: string): Promise<number> {
  const buffer = await readFile(filePath);
  if (buffer.length < 44) {
    return 0;
  }
  const sampleRate = buffer.readUInt32LE(24);
  const byteRate = buffer.readUInt32LE(28);

  for (let pos = 12; pos + 8 <= buffer.length; ) {
    const id = buffer.toString('ascii', pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    if (id === 'data') {
      return byteRate > 0 ? size / byteRate : size / (sampleRate * 2);
    }
    pos += 8 + size + (size % 2);
  }
  return 0;
}

export async function synthesizeMarks(
  marks: SpeechMark[]
): Promise<SpokenLine[]> {
  if (marks.length === 0) {
    return [];
  }

  const backend = await detectVoiceBackend();
  if (backend === 'none') {
    return [];
  }

  await mkdir(LINES_DIR, { recursive: true });
  const tag =
    backend === 'kokoro' ? String((await stat(KOKORO_MODEL)).size) : 'win-sapi';

  const mapped = marks.map((mark) => {
    const spokenText = applyPronunciations(mark.text);
    return {
      ...mark,
      spokenText,
      path: join(LINES_DIR, `${cacheKey(backend, spokenText, tag)}.wav`),
    };
  });

  const unique = mapped.filter(
    (item, idx) => mapped.findIndex((other) => other.path === item.path) === idx
  );
  const missingFlags = await Promise.all(
    unique.map((item) => fileExists(item.path))
  );
  const todo = unique.filter((_, idx) => !missingFlags[idx]);

  if (todo.length > 0) {
    if (backend === 'kokoro') {
      const pythonBin = await findKokoroPython();
      if (!pythonBin) {
        return [];
      }
      await runKokoroPython(pythonBin, {
        model: KOKORO_MODEL,
        voices: KOKORO_VOICES,
        voice: VOICE_NAME,
        lang: VOICE_LANG,
        speed: SPEED,
        sentencePause: SENTENCE_PAUSE,
        clausePause: CLAUSE_PAUSE,
        targetRms: TARGET_RMS,
        lines: todo.map((item) => ({ text: item.spokenText, path: item.path })),
      });
    } else {
      await runWindowsSapi(
        todo.map((item) => ({ text: item.spokenText, path: item.path })),
        SPEED,
        VOICE_NAME
      );
      await Promise.all(
        todo.map((item) => normalizePcm16Wav(item.path, TARGET_RMS))
      );
    }
  }

  return Promise.all(
    mapped.map(async (item) => ({
      at: item.at,
      text: item.text,
      path: item.path,
      seconds: await readWavSeconds(item.path),
    }))
  );
}

export function buildMixArgs(
  silentMp4: string,
  lines: SpokenLine[],
  outMp4: string,
  videoSeconds: number,
  videoArgs: string[]
): { args: string[]; overrun: number } {
  const overrun = Math.max(
    0,
    ...lines.map((line) => line.at + line.seconds - videoSeconds)
  );

  const inputs = lines.flatMap((line) => ['-i', line.path]);
  const delays = lines
    .map(
      (line, idx) =>
        `[${idx + 1}:a]adelay=${Math.max(0, Math.round(line.at * 1000))}:all=1[d${idx}]`
    )
    .join(';');
  const heads = lines.map((_, idx) => `[d${idx}]`).join('');
  const mix =
    lines.length === 1
      ? `${heads}anull[spoken]`
      : `${heads}amix=inputs=${lines.length}:normalize=0:dropout_transition=0[spoken]`;

  const padding = overrun > 0;
  const videoFilter = padding
    ? [
        '-filter_complex',
        `${delays};${mix};[0:v]tpad=stop_mode=clone:stop_duration=${overrun.toFixed(3)}[v]`,
        '-map',
        '[v]',
        ...videoArgs,
      ]
    : ['-filter_complex', `${delays};${mix}`, '-map', '0:v', '-c:v', 'copy'];

  return {
    overrun,
    args: [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      silentMp4,
      ...inputs,
      ...videoFilter,
      '-map',
      '[spoken]',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-ar',
      '48000',
      '-movflags',
      '+faststart',
      outMp4,
    ],
  };
}

export function estimateSpeechMs(text: string, minimumMs = 0): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const seconds = words / (3.4 * SPEED) + 0.45;
  return Math.max(minimumMs, Math.round(seconds * 1000));
}
