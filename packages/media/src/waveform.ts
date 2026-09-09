import { open } from 'node:fs/promises';
import type { WaveformPeaks } from '@rawedit/core';

/**
 * Peak envelope for the timeline, read straight from the 16 kHz mono PCM WAV the
 * transcriber already needs. No extra ffmpeg pass, no extra decode.
 */
export async function computeWaveformFromWav(
  wavPath: string,
  duration: number,
  resolution = 20,
): Promise<WaveformPeaks> {
  const handle = await open(wavPath, 'r');
  try {
    const header = Buffer.alloc(44);
    await handle.read(header, 0, 44, 0);

    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`${wavPath} is not a RIFF/WAVE file`);
    }

    const { dataOffset, dataLength, sampleRate, bitsPerSample, channels } = await readWavLayout(handle, header);
    if (bitsPerSample !== 16) {
      throw new Error(`Expected 16-bit PCM, found ${bitsPerSample}-bit`);
    }

    const bytesPerFrame = (bitsPerSample / 8) * channels;
    const totalFrames = Math.floor(dataLength / bytesPerFrame);
    const bucketCount = Math.max(1, Math.round(duration * resolution));
    const framesPerBucket = Math.max(1, Math.floor(totalFrames / bucketCount));

    const peaks = new Array<number>(bucketCount).fill(0);
    // 1 MiB at a time keeps memory flat regardless of recording length.
    const chunkFrames = Math.floor((1024 * 1024) / bytesPerFrame);
    const buffer = Buffer.alloc(chunkFrames * bytesPerFrame);

    let frameCursor = 0;
    let position = dataOffset;
    let remaining = dataLength;

    while (remaining > 0) {
      const toRead = Math.min(buffer.length, remaining);
      const { bytesRead } = await handle.read(buffer, 0, toRead, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      remaining -= bytesRead;

      const frames = Math.floor(bytesRead / bytesPerFrame);
      for (let frame = 0; frame < frames; frame += 1) {
        const sample = buffer.readInt16LE(frame * bytesPerFrame);
        const magnitude = Math.abs(sample) / 32768;
        const bucket = Math.min(bucketCount - 1, Math.floor((frameCursor + frame) / framesPerBucket));
        if (magnitude > peaks[bucket]!) peaks[bucket] = magnitude;
      }
      frameCursor += frames;
    }

    return { resolution, peaks: peaks.map((peak) => Number(peak.toFixed(4))) };
  } finally {
    await handle.close();
  }
}

/**
 * Walk the RIFF chunk list rather than assuming a 44-byte header — ffmpeg emits a
 * LIST/INFO chunk before `data`, so the fixed offset is wrong about half the time.
 */
async function readWavLayout(
  handle: Awaited<ReturnType<typeof open>>,
  header: Buffer,
): Promise<{ dataOffset: number; dataLength: number; sampleRate: number; bitsPerSample: number; channels: number }> {
  let offset = 12;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let channels = 1;
  const chunkHeader = Buffer.alloc(8);

  for (let guard = 0; guard < 64; guard += 1) {
    const { bytesRead } = await handle.read(chunkHeader, 0, 8, offset);
    if (bytesRead < 8) break;

    const id = chunkHeader.toString('ascii', 0, 4);
    const size = chunkHeader.readUInt32LE(4);

    if (id === 'fmt ') {
      const fmt = Buffer.alloc(Math.min(size, 40));
      await handle.read(fmt, 0, fmt.length, offset + 8);
      channels = fmt.readUInt16LE(2);
      sampleRate = fmt.readUInt32LE(4);
      bitsPerSample = fmt.readUInt16LE(14);
    } else if (id === 'data') {
      return { dataOffset: offset + 8, dataLength: size, sampleRate, bitsPerSample, channels };
    }

    // Chunks are word-aligned.
    offset += 8 + size + (size % 2);
  }

  // No `data` chunk found; fall back to the canonical layout.
  const totalSize = header.readUInt32LE(4) + 8;
  return { dataOffset: 44, dataLength: Math.max(0, totalSize - 44), sampleRate, bitsPerSample, channels };
}
