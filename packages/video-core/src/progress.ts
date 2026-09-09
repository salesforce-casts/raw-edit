export function analysisProgress(stage: "probe" | "hash" | "poster" | "proxy" | "done"): number {
  switch (stage) {
    case "probe":
      return 8;
    case "hash":
      return 12;
    case "poster":
      return 15;
    case "proxy":
      return 28;
    case "done":
      return 30;
  }
}

export function transcriptionProgress(fraction: number): number {
  return 30 + Math.round(Math.min(1, Math.max(0, fraction)) * 35);
}

export function retakeProgress(fraction: number): number {
  return 65 + Math.round(Math.min(1, Math.max(0, fraction)) * 30);
}

export function renderProgress(processedMs: number, expectedMs: number): number {
  if (expectedMs <= 0) return 0;
  return Math.min(99, Math.round((processedMs / expectedMs) * 100));
}
