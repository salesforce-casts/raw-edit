import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FFMPEG_PATH, run } from '@rawedit/media';

/**
 * Test fixtures built from real tools rather than checked-in binaries.
 *
 * When espeak-ng is available the source contains actual synthesised speech in the
 * classic retake pattern, so the whole pipeline — transcription included — can be
 * asserted on. Without it the source is tones, which still exercises probing,
 * silence detection, the EDL and rendering.
 */

export function hasBinary(command: string, args: string[] = ['--version']): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const HAS_ESPEAK = hasBinary('espeak-ng');
export const HAS_FFMPEG = hasBinary('ffmpeg', ['-version']);

/** The brief's worked example: two aborted attempts, then the complete sentence. */
export const RETAKE_SCRIPT = [
  "Today I'll show you three business ideas",
  "Today I'll show you",
  "Today I'll show you three business ideas that you can start under fifty thousand rupees.",
  'The first one is a print on demand store.',
] as const;

export interface SourceFixture {
  path: string;
  /** True when the audio contains real speech and take detection can be asserted. */
  hasSpeech: boolean;
  durationHint: number;
}

/**
 * Build a 640x360 30fps MP4 whose audio is either synthesised speech (preferred) or
 * tone bursts, with ~2s of silence between each utterance.
 */
export async function buildSourceVideo(dir: string): Promise<SourceFixture> {
  const videoPath = join(dir, 'IMG_TEST.mp4');

  if (HAS_ESPEAK) {
    const audioPath = await buildSpeechAudio(dir);
    await run(FFMPEG_PATH, [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=60',
      '-i', audioPath,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
      videoPath,
    ]);
    return { path: videoPath, hasSpeech: true, durationHint: 0 };
  }

  await run(FFMPEG_PATH, [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=20',
    '-f', 'lavfi', '-i',
    'aevalsrc=0.5*sin(440*2*PI*t)*(between(t\\,0\\,2)+between(t\\,7\\,9)+between(t\\,14\\,16)):s=48000:d=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest',
    videoPath,
  ]);
  return { path: videoPath, hasSpeech: false, durationHint: 20 };
}

/** Concatenate one synthesised utterance per line, separated by 2s of silence. */
async function buildSpeechAudio(dir: string): Promise<string> {
  const parts: string[] = [];
  const silencePath = join(dir, 'silence.wav');
  await run(FFMPEG_PATH, [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '2',
    silencePath,
  ]);

  for (const [index, line] of RETAKE_SCRIPT.entries()) {
    const utterancePath = join(dir, `utterance-${index}.wav`);
    execFileSync('espeak-ng', ['-s', '150', '-v', 'en-us', '-w', utterancePath, line], {
      stdio: 'ignore',
    });
    if (index > 0) parts.push(silencePath);
    parts.push(utterancePath);
  }

  const audioPath = join(dir, 'speech.wav');
  const inputs = parts.flatMap((part) => ['-i', part]);
  const filter = `${parts.map((_, index) => `[${index}]`).join('')}concat=n=${parts.length}:v=0:a=1[a]`;
  await run(FFMPEG_PATH, [
    '-hide_banner', '-nostdin', '-y',
    ...inputs,
    '-filter_complex', filter,
    '-map', '[a]',
    '-ar', '48000', '-ac', '1',
    audioPath,
  ]);
  return audioPath;
}
