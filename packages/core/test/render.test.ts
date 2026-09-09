import { describe, expect, it } from 'vitest';
import { applyPadding, buildRenderPlan, snapToFrameGrid } from '../src/render/plan.js';
import {
  buildConcatFilterGraph,
  buildRenderCommand,
  buildSelectExpression,
  reconnectArgs,
} from '../src/render/ffmpeg-args.js';
import { estimateExportSize, planExport } from '../src/render/presets.js';
import type { EditDecision } from '../src/types/edl.js';
import type { MediaMetadata } from '../src/types/media.js';
import { mapToEditedTime, mapToSourceTime } from '../src/util/ranges.js';

function remove(id: string, startTime: number, endTime: number): EditDecision {
  return { id, startTime, endTime, decision: 'remove', kind: 'silence', reason: 'x', confidence: 0.9, source: 'auto' };
}

function metadata(overrides: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    container: 'mov',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: 60,
    size: 500_000_000,
    bitrate: 60_000_000,
    video: {
      index: 0,
      codec: 'hevc',
      profile: 'Main 10',
      width: 3840,
      height: 2160,
      rotation: 0,
      pixelFormat: 'yuv420p10le',
      bitDepth: 10,
      frameRate: 30,
      avgFrameRate: 30,
      isVariableFrameRate: false,
      colorPrimaries: 'bt2020',
      colorTransfer: 'smpte2084',
      colorSpace: 'bt2020nc',
      colorRange: 'tv',
      displayAspectRatio: '16:9',
      bitrate: 58_000_000,
      nbFrames: 1800,
    },
    audio: { index: 1, codec: 'aac', channels: 2, sampleRate: 48000, bitrate: 192000, channelLayout: 'stereo' },
    hdr: { isHdr: true, format: 'HDR10', masterDisplay: null, maxCll: null },
    raw: {},
    ...overrides,
  };
}

const SDR_1080P = metadata({
  video: {
    ...metadata().video!,
    codec: 'h264',
    profile: 'High',
    width: 1920,
    height: 1080,
    pixelFormat: 'yuv420p',
    bitDepth: 8,
    colorPrimaries: 'bt709',
    colorTransfer: 'bt709',
    colorSpace: 'bt709',
  },
  hdr: { isHdr: false, format: null, masterDisplay: null, maxCll: null },
});

describe('buildRenderPlan', () => {
  it('inverts removals into keep ranges', () => {
    const plan = buildRenderPlan([remove('a', 5, 10), remove('b', 20, 25)], { duration: 30, frameRate: 30 });
    expect(plan.keepRanges).toHaveLength(3);
    expect(plan.keepRanges[0]!.start).toBe(0);
    expect(plan.outputDuration).toBeCloseTo(20, 1);
    expect(plan.cutCount).toBe(2);
  });

  it('snaps every boundary to a whole frame so audio cannot drift', () => {
    const plan = buildRenderPlan([remove('a', 5.0137, 10.0219)], { duration: 30, frameRate: 30 });
    const frame = 1 / 30;
    /** Distance from the nearest frame boundary, in seconds. */
    const offGrid = (time: number) => {
      const frames = time / frame;
      return Math.abs(frames - Math.round(frames)) * frame;
    };
    for (const range of plan.keepRanges) {
      // Boundaries are serialised to ffmpeg with 6 decimals, so microsecond-level
      // rounding is the floor here; what matters is that it is far below a frame.
      expect(offGrid(range.start)).toBeLessThan(1e-5);
      // The tail is clipped to the media duration, which need not be on the grid.
      if (range.end < 30 - frame) expect(offGrid(range.end)).toBeLessThan(1e-5);
      // Each kept span is a whole number of frames, which is what keeps audio and
      // video locked together across many cuts.
      const frames = (range.end - range.start) / frame;
      if (range.end < 30 - frame) expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-3);
    }
  });

  it('drops keep ranges too short to be worth a cut', () => {
    const plan = buildRenderPlan([remove('a', 1, 5), remove('b', 5.1, 10)], {
      duration: 20,
      frameRate: 30,
      minSegmentSeconds: 0.35,
      mergeGapMs: 0,
    });
    expect(plan.keepRanges.every((range) => range.end - range.start >= 0.3)).toBe(true);
  });

  it('merges keep ranges that are closer than the merge gap', () => {
    const plan = buildRenderPlan([remove('a', 5, 5.05)], { duration: 20, frameRate: 30, mergeGapMs: 120 });
    expect(plan.keepRanges).toHaveLength(1);
  });

  it('reports a whole-file keep as passthrough', () => {
    const plan = buildRenderPlan([], { duration: 20, frameRate: 30 });
    expect(plan.isPassthrough).toBe(true);
    expect(plan.outputDuration).toBeCloseTo(20, 2);
  });

  it('never produces an output longer than the source', () => {
    const plan = buildRenderPlan([remove('a', 1, 2)], { duration: 10, frameRate: 30 });
    expect(plan.outputDuration).toBeLessThanOrEqual(10);
  });
});

describe('snapToFrameGrid', () => {
  it('expands outwards so no speech is clipped', () => {
    const snapped = snapToFrameGrid({ start: 1.017, end: 2.004 }, 30, 10);
    expect(snapped.start).toBeLessThanOrEqual(1.017);
    expect(snapped.end).toBeGreaterThanOrEqual(2.004);
  });
});

describe('applyPadding', () => {
  it('keeps padding on both sides of a removal', () => {
    const [padded] = applyPadding([{ start: 5, end: 10 }], { padPreMs: 160, padPostMs: 200 }, 30);
    expect(padded!.start).toBeCloseTo(5.2, 3);
    expect(padded!.end).toBeCloseTo(9.84, 3);
  });

  it('does not pad against the start or end of the file', () => {
    const padded = applyPadding([{ start: 0, end: 3 }, { start: 27, end: 30 }], { padPreMs: 160, padPostMs: 200 }, 30);
    expect(padded[0]!.start).toBe(0);
    expect(padded[1]!.end).toBe(30);
  });
});

describe('buildSelectExpression', () => {
  it('joins ranges with +', () => {
    expect(buildSelectExpression([{ start: 0, end: 5.24 }, { start: 9.1, end: 17.48 }])).toBe(
      'between(t,0.000000,5.240000)+between(t,9.100000,17.480000)',
    );
  });

  it('selects nothing for an empty plan', () => {
    expect(buildSelectExpression([])).toBe('0');
  });
});

describe('buildConcatFilterGraph', () => {
  it('splits, trims and concatenates both streams', () => {
    const graph = buildConcatFilterGraph([{ start: 0, end: 1 }, { start: 2, end: 3 }], [], true);
    expect(graph).toContain('[0:v]split=2[vin0][vin1]');
    expect(graph).toContain('[0:a]asplit=2[ain0][ain1]');
    expect(graph).toContain('concat=n=2:v=1:a=1[outv][outa]');
  });

  it('omits audio when the source has none', () => {
    const graph = buildConcatFilterGraph([{ start: 0, end: 1 }, { start: 2, end: 3 }], [], false);
    expect(graph).not.toContain('asplit');
    expect(graph).toContain('concat=n=2:v=1:a=0[outv]');
  });
});

describe('buildRenderCommand', () => {
  const plan = buildRenderPlan([remove('a', 5, 10)], { duration: 60, frameRate: 30 });

  it('reads the original master, never a proxy', () => {
    const command = buildRenderCommand({
      inputUrl: 'https://r2.example/originals/u1/v1/IMG_4821.MOV?sig=x',
      outputPath: '/tmp/out.mp4',
      metadata: metadata(),
      plan,
      presetId: 'ORIGINAL_QUALITY',
    });
    const inputIndex = command.args.indexOf('-i');
    expect(command.args[inputIndex + 1]).toContain('originals/');
  });

  it('keeps 4K at 4K on the default preset', () => {
    const command = buildRenderCommand({
      inputUrl: 'in.mov',
      outputPath: 'out.mp4',
      metadata: metadata(),
      plan,
      presetId: 'ORIGINAL_QUALITY',
    });
    expect(command.plan.width).toBe(3840);
    expect(command.plan.height).toBe(2160);
    expect(command.plan.frameRate).toBe(30);
    expect(command.args.join(' ')).not.toContain('scale=');
  });

  it('uses the sample-accurate trim/concat strategy by default', () => {
    // `atrim` cuts on sample boundaries; `aselect` can only drop whole ~21ms audio
    // frames, which accumulates real drift. Concat is therefore the default.
    const command = buildRenderCommand({
      inputUrl: 'in.mov',
      outputPath: 'out.mp4',
      metadata: SDR_1080P,
      plan,
      presetId: 'ORIGINAL_QUALITY',
    });
    expect(command.strategy).toBe('filter_concat');
    const joined = command.args.join(' ');
    expect(joined).toContain('atrim=start=');
    expect(joined).toContain('concat=n=2:v=1:a=1');
    expect(joined).not.toContain("aselect='");
  });

  it('uses trim/concat for a VFR source too', () => {
    const vfr = metadata({ video: { ...metadata().video!, isVariableFrameRate: true } });
    const command = buildRenderCommand({ inputUrl: 'in.mov', outputPath: 'out.mp4', metadata: vfr, plan, presetId: 'ORIGINAL_QUALITY' });
    expect(command.strategy).toBe('filter_concat');
    expect(command.args.join(' ')).toContain('concat=n=2');
  });

  it('falls back to select past the segment cap and warns about audio alignment', () => {
    const many = buildRenderPlan(
      Array.from({ length: 80 }, (_, i) => remove(`r${i}`, i * 0.7 + 0.3, i * 0.7 + 0.5)),
      { duration: 60, frameRate: 30 },
    );
    const command = buildRenderCommand({
      inputUrl: 'in.mov',
      outputPath: 'out.mp4',
      metadata: metadata(),
      plan: many,
      presetId: 'ORIGINAL_QUALITY',
      maxConcatSegments: 60,
    });
    expect(command.strategy).toBe('filter_select');
    expect(command.args.join(' ')).toContain('setpts=N/FRAME_RATE/TB');
    expect(command.warnings.join(' ')).toMatch(/audio frame/i);
    expect(command.args).toContain('-fps_mode');
  });

  it('preserves HDR signalling on an HDR source', () => {
    const hdr = metadata({
      hdr: { isHdr: true, format: 'HDR10', masterDisplay: 'G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1)', maxCll: '1000,400' },
    });
    const command = buildRenderCommand({ inputUrl: 'in.mov', outputPath: 'out.mp4', metadata: hdr, plan, presetId: 'ORIGINAL_QUALITY' });
    const joined = command.args.join(' ');
    expect(joined).toContain('libx265');
    expect(joined).toContain('yuv420p10le');
    expect(joined).toContain('hdr-opt=1');
    expect(joined).toContain('transfer=smpte2084');
    expect(joined).toContain('master-display=');
    expect(joined).toContain('max-cll=1000,400');
    expect(joined).not.toContain('tonemap');
  });

  it('does not tone-map unless a compatible SDR export was chosen', () => {
    const hdr = metadata();
    const preserve = buildRenderCommand({ inputUrl: 'in.mov', outputPath: 'o.mp4', metadata: hdr, plan, presetId: 'ORIGINAL_QUALITY' });
    expect(preserve.args.join(' ')).not.toContain('tonemap');

    const compatible = buildRenderCommand({ inputUrl: 'in.mov', outputPath: 'o.mp4', metadata: hdr, plan, presetId: 'SOCIAL_MEDIA' });
    expect(compatible.args.join(' ')).toContain('tonemap');
    expect(compatible.plan.toneMapped).toBe(true);
    expect(compatible.warnings.join(' ')).toMatch(/tone-mapped/i);
  });

  it('always writes explicit colour tags, which is what stops washed-out output', () => {
    const sdr = buildRenderCommand({ inputUrl: 'in.mov', outputPath: 'o.mp4', metadata: SDR_1080P, plan, presetId: 'ORIGINAL_QUALITY' });
    expect(sdr.args).toContain('-color_primaries');
    expect(sdr.args[sdr.args.indexOf('-color_primaries') + 1]).toBe('bt709');
    expect(sdr.args[sdr.args.indexOf('-color_trc') + 1]).toBe('bt709');

    const toneMapped = buildRenderCommand({ inputUrl: 'in.mov', outputPath: 'o.mp4', metadata: metadata(), plan, presetId: 'SOCIAL_MEDIA' });
    expect(toneMapped.args[toneMapped.args.indexOf('-color_trc') + 1]).toBe('bt709');
  });

  it('warns that Dolby Vision cannot be re-encoded rather than pretending it survived', () => {
    const dv = metadata({ hdr: { isHdr: true, format: 'DOLBY_VISION', masterDisplay: null, maxCll: null } });
    const command = buildRenderCommand({ inputUrl: 'in.mov', outputPath: 'o.mp4', metadata: dv, plan, presetId: 'ORIGINAL_QUALITY' });
    expect(command.warnings.join(' ')).toMatch(/Dolby Vision/i);
  });

  it('uses H.264 and faststart for the compatible preset', () => {
    const command = buildRenderCommand({ inputUrl: 'in.mov', outputPath: 'o.mp4', metadata: metadata(), plan, presetId: 'SOCIAL_MEDIA' });
    expect(command.args.join(' ')).toContain('libx264');
    expect(command.args.join(' ')).toContain('+faststart');
    expect(command.plan.videoCodec).toBe('h264');
  });

  it('tags HEVC as hvc1 so QuickTime and Safari can play it', () => {
    const command = buildRenderCommand({ inputUrl: 'in.mov', outputPath: 'o.mp4', metadata: metadata(), plan, presetId: 'ORIGINAL_QUALITY' });
    expect(command.args[command.args.indexOf('-tag:v') + 1]).toBe('hvc1');
  });

  it('emits machine-readable progress so the UI can show a real number', () => {
    const command = buildRenderCommand({ inputUrl: 'in.mov', outputPath: 'o.mp4', metadata: metadata(), plan, presetId: 'ORIGINAL_QUALITY' });
    expect(command.args).toContain('-progress');
    expect(command.expectedDuration).toBeCloseTo(plan.outputDuration, 3);
  });

  it('encodes exactly once — no intermediate output file appears in the args', () => {
    const command = buildRenderCommand({ inputUrl: 'in.mov', outputPath: '/tmp/final.mp4', metadata: metadata(), plan, presetId: 'ORIGINAL_QUALITY' });
    expect(command.args.filter((arg) => arg.endsWith('.mp4'))).toEqual(['/tmp/final.mp4']);
    expect(command.args.filter((arg) => arg === '-i')).toHaveLength(1);
  });

  it('drops the audio encoder when the source has no audio track', () => {
    const silent = metadata({ audio: null });
    const command = buildRenderCommand({ inputUrl: 'in.mov', outputPath: 'o.mp4', metadata: silent, plan, presetId: 'ORIGINAL_QUALITY' });
    expect(command.args).toContain('-an');
  });
});

describe('planExport', () => {
  it('keeps the source resolution on Original Quality', () => {
    const summary = planExport(metadata(), 'ORIGINAL_QUALITY', 120);
    expect(summary.width).toBe(3840);
    expect(summary.scaled).toBe(false);
  });

  it('caps Social Media at 1080p and says it scaled', () => {
    const summary = planExport(metadata(), 'SOCIAL_MEDIA', 120);
    expect(Math.max(summary.width, summary.height)).toBeLessThanOrEqual(1920);
    expect(summary.scaled).toBe(true);
    expect(summary.warnings.join(' ')).toContain('3840×2160');
  });

  it('reports portrait dimensions for a rotated iPhone capture', () => {
    const portrait = metadata({ video: { ...metadata().video!, width: 1920, height: 1080, rotation: 90 } });
    const summary = planExport(portrait, 'ORIGINAL_QUALITY', 60);
    expect(summary.width).toBe(1080);
    expect(summary.height).toBe(1920);
  });
});

describe('estimateExportSize', () => {
  const base = { width: 1920, height: 1080, frameRate: 30, durationSeconds: 60, audioBitrateKbps: 160 } as const;

  it('grows with duration', () => {
    const short = estimateExportSize({ ...base, codec: 'h264', crf: 20 });
    const long = estimateExportSize({ ...base, durationSeconds: 120, codec: 'h264', crf: 20 });
    expect(long).toBeGreaterThan(short * 1.9);
  });

  it('shrinks as CRF rises', () => {
    expect(estimateExportSize({ ...base, codec: 'h264', crf: 26 })).toBeLessThan(
      estimateExportSize({ ...base, codec: 'h264', crf: 18 }),
    );
  });

  it('rates HEVC below H.264 at the same quality', () => {
    expect(estimateExportSize({ ...base, codec: 'hevc', crf: 20 })).toBeLessThan(
      estimateExportSize({ ...base, codec: 'h264', crf: 20 }),
    );
  });

  it('lands in a believable range for 1080p30 at CRF 20', () => {
    const bytes = estimateExportSize({ ...base, codec: 'h264', crf: 20 });
    const mbps = (bytes * 8) / 60 / 1_000_000;
    expect(mbps).toBeGreaterThan(3);
    expect(mbps).toBeLessThan(30);
  });

  it('returns zero for an empty edit', () => {
    expect(estimateExportSize({ ...base, durationSeconds: 0, codec: 'h264', crf: 20 })).toBe(0);
  });
});

describe('timeline mapping', () => {
  const keep = [
    { start: 0, end: 5 },
    { start: 10, end: 20 },
  ];

  it('maps source time onto the edited timeline', () => {
    expect(mapToEditedTime(keep, 3)).toBe(3);
    expect(mapToEditedTime(keep, 12)).toBe(7);
    expect(mapToEditedTime(keep, 7)).toBeNull();
  });

  it('round-trips back to source time', () => {
    expect(mapToSourceTime(keep, 7)).toBe(12);
    expect(mapToSourceTime(keep, 3)).toBe(3);
    expect(mapToSourceTime(keep, 99)).toBeNull();
  });
});

describe('reconnect flags', () => {
  it('are added for an object-storage URL', () => {
    expect(reconnectArgs('https://r2.example/originals/a/b/c.mov?sig=1')).toContain('-reconnect');
  });

  it('are omitted for a local path, which ffmpeg rejects them on', () => {
    expect(reconnectArgs('/tmp/source.mov')).toEqual([]);
    expect(reconnectArgs('source.mp4')).toEqual([]);
  });
});
