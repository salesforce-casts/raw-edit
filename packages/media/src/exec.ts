import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export const FFMPEG_PATH = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
export const FFPROBE_PATH = process.env['FFPROBE_PATH'] ?? 'ffprobe';

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export interface RunOptions {
  /** Called for each `-progress` block ffmpeg writes to stdout. */
  onProgress?: (fields: Record<string, string>) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
  /** Tail of stderr retained for the error message and the render log. */
  stderrLimit?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Spawn ffmpeg/ffprobe and stream its output.
 *
 * `-progress pipe:1` writes `key=value` blocks terminated by `progress=continue`,
 * which is how render progress is measured rather than estimated.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // stdin is 'ignore': ffmpeg is always driven by arguments, never by a pipe.
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error: unknown) {
      reject(new FfmpegError(`Could not start ${command}`, null, String(error)));
      return;
    }

    const stderrLimit = options.stderrLimit ?? 64_000;
    let stdout = '';
    let stderr = '';
    let progressBuffer = '';
    let stderrBuffer = '';
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      // A stuck encoder must not hold the worker slot forever.
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
      if (!options.onProgress) return;

      progressBuffer += text;
      let index = progressBuffer.indexOf('\n');
      const fields: Record<string, string> = {};
      while (index !== -1) {
        const line = progressBuffer.slice(0, index).trim();
        progressBuffer = progressBuffer.slice(index + 1);
        const equals = line.indexOf('=');
        if (equals > 0) {
          const key = line.slice(0, equals);
          fields[key] = line.slice(equals + 1);
          if (key === 'progress') {
            options.onProgress({ ...fields });
            for (const field of Object.keys(fields)) delete fields[field];
          }
        }
        index = progressBuffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > stderrLimit) stderr = stderr.slice(-stderrLimit);
      if (!options.onStderrLine) return;

      stderrBuffer += text;
      let index = stderrBuffer.indexOf('\n');
      while (index !== -1) {
        options.onStderrLine(stderrBuffer.slice(0, index));
        stderrBuffer = stderrBuffer.slice(index + 1);
        index = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(new FfmpegError(`${command} failed to start: ${error.message}`, null, stderr));
    });

    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (stderrBuffer.length > 0) options.onStderrLine?.(stderrBuffer);
      if (aborted) {
        reject(new FfmpegError(`${command} was cancelled`, code, stderr));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new FfmpegError(`${command} exited with code ${code}: ${lastMeaningfulLine(stderr)}`, code, stderr));
      }
    });
  });
}

/** ffmpeg's actual error is usually the last non-progress line. */
function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('frame=') && !line.startsWith('size='));
  return lines.slice(-3).join(' | ').slice(0, 500);
}

/** ffmpeg reports elapsed output time in microseconds. */
export function progressSeconds(fields: Record<string, string>): number | null {
  const micros = fields['out_time_us'] ?? fields['out_time_ms'];
  if (micros) {
    const value = Number.parseInt(micros, 10);
    if (Number.isFinite(value) && value >= 0) return value / 1_000_000;
  }
  const timecode = fields['out_time'];
  if (timecode) {
    const match = /(\d+):(\d+):([\d.]+)/.exec(timecode);
    if (match) {
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
  }
  return null;
}
