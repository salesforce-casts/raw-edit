export type WaveformData = {
  version: 1;
  durationMs: number;
  sampleRate: number;
  peaks: number[];
};

function ascii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(view.getUint8(offset + index));
  return value;
}

export function waveformPeaksFromPcm16Wav(bytes: Uint8Array, peakCount = 4096): WaveformData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 44 || ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") {
    throw new Error("Unsupported waveform source: expected a RIFF/WAVE file");
  }

  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataOffset = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(view, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    if (id === "fmt " && length >= 16 && payloadOffset + 16 <= view.byteLength) {
      audioFormat = view.getUint16(payloadOffset, true);
      channels = view.getUint16(payloadOffset + 2, true);
      sampleRate = view.getUint32(payloadOffset + 4, true);
      bitsPerSample = view.getUint16(payloadOffset + 14, true);
    }
    if (id === "data") {
      dataOffset = payloadOffset;
      dataLength = Math.min(length, view.byteLength - payloadOffset);
      break;
    }
    offset = payloadOffset + length + (length % 2);
  }

  if (audioFormat !== 1 || channels < 1 || sampleRate < 1 || bitsPerSample !== 16 || dataOffset < 0) {
    throw new Error("Unsupported waveform source: expected 16-bit PCM audio");
  }

  const frameBytes = channels * 2;
  const frameCount = Math.floor(dataLength / frameBytes);
  const targetCount = Math.max(1, Math.min(Math.floor(peakCount), frameCount || 1));
  const framesPerPeak = Math.max(1, Math.ceil(frameCount / targetCount));
  const peaks: number[] = [];
  for (let fromFrame = 0; fromFrame < frameCount; fromFrame += framesPerPeak) {
    const toFrame = Math.min(frameCount, fromFrame + framesPerPeak);
    let peak = 0;
    for (let frame = fromFrame; frame < toFrame; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sampleOffset = dataOffset + frame * frameBytes + channel * 2;
        peak = Math.max(peak, Math.abs(view.getInt16(sampleOffset, true)) / 32768);
      }
    }
    peaks.push(Number(peak.toFixed(4)));
  }

  return {
    version: 1,
    durationMs: Math.round((frameCount / sampleRate) * 1000),
    sampleRate,
    peaks,
  };
}
