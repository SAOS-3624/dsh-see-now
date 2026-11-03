/**
 * media.js — 可选读取媒体文件时长；探测失败只隐藏总时长，不影响回放。
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { resolveFfmpeg } from './binaries.js';

const mediaCache = new Map();

export async function probeMedia(path, { ffmpegPath = null, timeoutMs = 3000, env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (env.DSH_FFPROBE_PATH) candidates.push(env.DSH_FFPROBE_PATH);
  else {
    try {
      const ffmpeg = ffmpegPath || resolveFfmpeg({ env, platform }).path;
      candidates.push(join(dirname(ffmpeg), platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
    } catch { /* ignore */ }
    for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
      candidates.push(join(dir, platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
    }
    if (platform === 'darwin') candidates.push('/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe');
  }
  const executable = candidates.find((entry) => {
    try { accessSync(entry, platform === 'win32' ? constants.F_OK : constants.X_OK); return statSync(entry).isFile(); } catch { return false; }
  });
  if (!executable) return { durationSec: null };
  let key;
  try {
    const stat = statSync(path);
    key = `${resolve(path)}\0${stat.size}\0${stat.mtimeMs}\0${executable}`;
  } catch { return { durationSec: null }; }
  if (mediaCache.has(key)) return mediaCache.get(key);
  const result = new Promise((resolveProbe) => {
    execFile(executable, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', String(path)],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
        let durationSec = null;
        if (!error) {
          try {
            const value = Number(JSON.parse(stdout).format?.duration);
            if (Number.isFinite(value) && value > 0) durationSec = value;
          } catch { /* 时长未知不影响回放 */ }
        }
        resolveProbe({ durationSec });
      });
  });
  mediaCache.set(key, result);
  return result;
}
