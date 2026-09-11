import { describe, expect, it } from "vitest";
import { waveformPeaksFromPcm16Wav } from "./waveform";

function pcm16Wav(samples: number[], sampleRate = 4): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

describe("waveform peaks", () => {
  it("downsamples PCM audio into normalized peak buckets", () => {
    const waveform = waveformPeaksFromPcm16Wav(pcm16Wav([0, 16384, -32768, 8192]), 2);
    expect(waveform).toEqual({ version: 1, durationMs: 1000, sampleRate: 4, peaks: [0.5, 1] });
  });

  it("rejects non-wave input", () => {
    expect(() => waveformPeaksFromPcm16Wav(new Uint8Array(44))).toThrow(/RIFF\/WAVE/);
  });
});
