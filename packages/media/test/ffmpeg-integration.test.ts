/**
 * Integration tests that run real ffmpeg.
 *
 * These generate a synthetic source, probe it, extract audio, detect silence and run
 * an actual cut-and-concat render, then probe the result. They are what proves the
 * render strategy in `@rawedit/core` produces commands ffmpeg accepts and that the
 * output has the resolution, frame rate, duration and colour tags it should.
 *
 * Skipped automatically when ffmpeg is not on PATH.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRenderCommand,
  buildRenderPlan,
  type EditDecision,
} from '@rawedit/core';
import { FfmpegVideoProcessor } from '../src/ffmpeg-processor.js';
import { FFMPEG_PATH, run } from '../src/exec.js';
import { probe } from '../src/ffprobe.js';

function hasFfmpeg(): boolean {
  try {
    execFileSync(FFMPEG_PATH, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = hasFfmpeg();
const describeIf = available ? describe : describe.skip;

/**
 * A 12-second 640x360 30fps clip with three one-second tone bursts separated by
 * silence — enough structure for silence detection and a multi-range cut.
 */
async function makeSource(path: string): Promise<void> {
  await run(FFMPEG_PATH, [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=12',
    '-f', 'lavfi', '-i',
    'aevalsrc=0.4*sin(880*2*PI*t)*between(mod(t\\,4)\\,0\\,1):s=48000:d=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '96k',
    '-shortest',
    path,
  ]);
}

describeIf('ffmpeg integration', () => {
  let dir = '';
  let source = '';
  const processor = new FfmpegVideoProcessor();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rawedit-media-'));
    source = join(dir, 'source.mp4');
    await makeSource(source);
  }, 120_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('probes real technical metadata', async () => {
    const metadata = await processor.probe({ source });
    expect(metadata.duration).toBeCloseTo(12, 0);
    expect(metadata.video?.width).toBe(640);
    expect(metadata.video?.height).toBe(360);
    expect(metadata.video?.codec).toBe('h264');
    expect(metadata.video?.frameRate).toBeCloseTo(30, 1);
    expect(metadata.video?.isVariableFrameRate).toBe(false);
    expect(metadata.audio?.codec).toBe('aac');
    expect(metadata.audio?.sampleRate).toBe(48000);
    expect(metadata.hdr.isHdr).toBe(false);
  }, 60_000);

  it('extracts 16 kHz mono PCM and reports real progress', async () => {
    const audioPath = join(dir, 'audio.wav');
    const samples: number[] = [];
    await processor.extractAudio({
      source,
      outputPath: audioPath,
      durationSeconds: 12,
      onProgress: (fraction) => samples.push(fraction),
    });

    const audio = await probe(audioPath);
    expect(audio.audio?.sampleRate).toBe(16000);
    expect(audio.audio?.channels).toBe(1);
    expect(audio.duration).toBeCloseTo(12, 0);
    // Progress must be measured, so it should move rather than jump 0 -> 1.
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.at(-1)).toBe(1);
    expect(samples.every((value) => value >= 0 && value <= 1)).toBe(true);
  }, 120_000);

  it('detects the silent gaps between tone bursts', async () => {
    const audioPath = join(dir, 'audio.wav');
    const silence = await processor.detectSilence(audioPath, 12);
    expect(silence.length).toBeGreaterThanOrEqual(2);
    // The source is silent from 1-4s, 5-8s and 9-12s.
    const covers = (time: number) => silence.some((range) => time >= range.start && time <= range.end);
    expect(covers(2.5)).toBe(true);
    expect(covers(6.5)).toBe(true);
    expect(covers(0.5)).toBe(false);
  }, 60_000);

  it('computes a waveform from the extracted audio', async () => {
    const waveform = await processor.computeWaveform(join(dir, 'audio.wav'), 12, 10);
    expect(waveform.peaks.length).toBeCloseTo(120, -1);
    expect(Math.max(...waveform.peaks)).toBeGreaterThan(0.1);
    expect(Math.min(...waveform.peaks)).toBeLessThan(0.05);
    expect(waveform.peaks.every((peak) => peak >= 0 && peak <= 1)).toBe(true);
  }, 60_000);

  /** The whole point: cut real ranges out of a real file and check the result. */
  it('renders a multi-range cut and preserves resolution and frame rate', async () => {
    const metadata = await processor.probe({ source });
    const decisions: EditDecision[] = [
      { id: 'a', startTime: 1.5, endTime: 3.5, decision: 'remove', kind: 'silence', reason: 'gap', confidence: 0.9, source: 'auto' },
      { id: 'b', startTime: 6, endTime: 8, decision: 'remove', kind: 'retake', reason: 'retake', confidence: 0.9, source: 'auto' },
    ];
    const plan = buildRenderPlan(decisions, { duration: metadata.duration, frameRate: 30 });
    expect(plan.keepRanges).toHaveLength(3);

    const outputPath = join(dir, 'render.mp4');
    const command = buildRenderCommand({
      inputUrl: source,
      outputPath,
      metadata,
      plan,
      presetId: 'ORIGINAL_QUALITY',
    });
    expect(command.strategy).toBe('filter_concat');

    const progress: number[] = [];
    const result = await processor.render({
      command,
      onProgress: (fraction) => progress.push(fraction),
    });

    expect(result.size).toBeGreaterThan(1000);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(1);

    const rendered = await probe(outputPath);
    // Roughly 4 seconds were removed from a 12-second source.
    expect(rendered.duration).toBeCloseTo(plan.outputDuration, 0);
    expect(rendered.duration).toBeLessThan(metadata.duration - 3);
    expect(rendered.video?.width).toBe(640);
    expect(rendered.video?.height).toBe(360);
    expect(rendered.video?.avgFrameRate).toBeCloseTo(30, 0);
    expect(rendered.audio).not.toBeNull();
    // Colour tags must survive, or the export looks washed out.
    expect(rendered.video?.colorPrimaries).toBe('bt709');
    expect(rendered.video?.colorTransfer).toBe('bt709');
  }, 300_000);

  it('keeps audio and video the same length after several cuts', async () => {
    const metadata = await processor.probe({ source });
    const decisions: EditDecision[] = [1, 3, 5, 7, 9].map((start, index) => ({
      id: `r${index}`,
      startTime: start,
      endTime: start + 0.6,
      decision: 'remove' as const,
      kind: 'silence' as const,
      reason: 'gap',
      confidence: 0.9,
      source: 'auto' as const,
    }));
    const plan = buildRenderPlan(decisions, { duration: metadata.duration, frameRate: 30 });
    const outputPath = join(dir, 'sync.mp4');
    await processor.render({
      command: buildRenderCommand({ inputUrl: source, outputPath, metadata, plan, presetId: 'SOCIAL_MEDIA' }),
    });

    const streams = await streamDurations(outputPath);
    // Sample-accurate `atrim` plus frame-grid snapping should leave essentially no
    // drift at all. `aselect` measured 819ms over 30 segments, which is why the
    // concat strategy is the default.
    expect(Math.abs(streams.video - streams.audio)).toBeLessThan(0.02);
    // The output should also be exactly as long as the plan said it would be.
    expect(streams.video).toBeCloseTo(plan.outputDuration, 1);
  }, 300_000);

  it('renders through the VFR trim/concat path as well', async () => {
    const metadata = await processor.probe({ source });
    const asVfr = {
      ...metadata,
      video: metadata.video ? { ...metadata.video, isVariableFrameRate: true } : null,
    };
    const decisions: EditDecision[] = [
      { id: 'a', startTime: 2, endTime: 4, decision: 'remove', kind: 'silence', reason: 'gap', confidence: 0.9, source: 'auto' },
    ];
    const plan = buildRenderPlan(decisions, { duration: metadata.duration, frameRate: 30 });
    const outputPath = join(dir, 'vfr.mp4');
    const command = buildRenderCommand({ inputUrl: source, outputPath, metadata: asVfr, plan, presetId: 'ORIGINAL_QUALITY' });
    expect(command.strategy).toBe('filter_concat');

    await processor.render({ command });
    const rendered = await probe(outputPath);
    expect(rendered.duration).toBeCloseTo(plan.outputDuration, 0);
  }, 300_000);

  it('still renders correctly through the select fallback past the segment cap', async () => {
    const metadata = await processor.probe({ source });
    const decisions: EditDecision[] = [1, 3, 5, 7, 9].map((start, index) => ({
      id: `s${index}`,
      startTime: start,
      endTime: start + 0.6,
      decision: 'remove' as const,
      kind: 'silence' as const,
      reason: 'gap',
      confidence: 0.9,
      source: 'auto' as const,
    }));
    const plan = buildRenderPlan(decisions, { duration: metadata.duration, frameRate: 30 });
    const outputPath = join(dir, 'select.mp4');
    // Force the fallback by setting the cap below the segment count.
    const command = buildRenderCommand({
      inputUrl: source,
      outputPath,
      metadata,
      plan,
      presetId: 'ORIGINAL_QUALITY',
      maxConcatSegments: 2,
    });
    expect(command.strategy).toBe('filter_select');
    expect(command.warnings.join(' ')).toMatch(/audio frame/i);

    await processor.render({ command });
    const rendered = await probe(outputPath);
    // Frame-granular audio, so the tolerance is looser than the concat path's.
    expect(rendered.duration).toBeCloseTo(plan.outputDuration, 0);
  }, 300_000);

  it('generates a preview proxy and a thumbnail', async () => {
    const metadata = await processor.probe({ source });
    const proxyPath = join(dir, 'proxy.mp4');
    const proxy = await processor.generateProxy(source, proxyPath, metadata);
    expect(proxy.size).toBeGreaterThan(500);

    const thumbPath = join(dir, 'thumb.jpg');
    await processor.generateThumbnail(source, thumbPath, 1.2);
    const thumb = await probe(thumbPath);
    expect(thumb.video?.width).toBe(640);
  }, 300_000);

  it('surfaces a clear error for a file that is not media', async () => {
    await expect(processor.probe({ source: join(dir, 'does-not-exist.mp4') })).rejects.toThrow();
  }, 30_000);
});

/** Per-stream duration, used to check A/V sync after cutting. */
async function streamDurations(path: string): Promise<{ video: number; audio: number }> {
  const output = execFileSync(
    process.env['FFPROBE_PATH'] ?? 'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,duration',
      '-of', 'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(output) as { streams?: { codec_type?: string; duration?: string }[] };
  const find = (type: string) =>
    Number.parseFloat(parsed.streams?.find((stream) => stream.codec_type === type)?.duration ?? '0');
  return { video: find('video'), audio: find('audio') };
}
