"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { EditSegment, Word } from "@raw-edit/contracts";
import { waveformPeaksFromPcm16Wav, type WaveformData } from "@raw-edit/core";
import { originalDuration, proposedDuration, transcriptTextForRange } from "@raw-edit/video-core";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { formatMs } from "@/lib/format";

type VideoRow = {
  id: string;
  status: string;
  progress: number;
  progressMessage?: string | null;
  originalFilename: string;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  errorMessage?: string | null;
  scriptPassWarning?: string | null;
  proxyStorageKey?: string | null;
  audioStorageKey?: string | null;
};

export function ReviewEditor({ videoId }: { videoId: string }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [video, setVideo] = useState<VideoRow | null>(null);
  const [segments, setSegments] = useState<EditSegment[]>([]);
  const [history, setHistory] = useState<EditSegment[][]>([]);
  const [future, setFuture] = useState<EditSegment[][]>([]);
  const [playbackUrl, setPlaybackUrl] = useState<string>();
  const playbackUrlRef = useRef<string | undefined>(undefined);
  const proxyRequestInFlightRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [completedExportId, setCompletedExportId] = useState<string>();
  const [words, setWords] = useState<Word[]>([]);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [resetting, setResetting] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [waveform, setWaveform] = useState<WaveformData>();
  const waveformRequestInFlightRef = useRef(false);
  const statusRef = useRef<string | undefined>(undefined);

  async function load() {
    const [videoRes, editRes, transcriptRes] = await Promise.all([
      fetch(`/api/videos/${videoId}`),
      fetch(`/api/videos/${videoId}/edit`),
      fetch(`/api/videos/${videoId}/transcript`),
    ]);
    if (videoRes.ok) {
      const json = (await videoRes.json()) as { video: VideoRow; latestExport?: { id: string } | null };
      setVideo(json.video);
      statusRef.current = json.video.status;
      if (json.video.status === "READY_FOR_REVIEW" || json.video.status === "COMPLETE" || json.video.status === "FAILED") {
        setResetting(false);
      }
      setCompletedExportId(json.latestExport?.id);
      if (json.video.audioStorageKey) void loadWaveform();
    }
    if (editRes.ok) {
      const json = (await editRes.json()) as { segments: EditSegment[] };
      setSegments(json.segments);
    }
    if (transcriptRes.ok) {
      const json = (await transcriptRes.json()) as { segments?: Array<{ wordsJson?: Word[]; words?: Word[] }> };
      const next = (json.segments ?? []).flatMap((segment) => segment.wordsJson ?? segment.words ?? []);
      setWords(next);
    }
  }

  async function loadProxy() {
    if (playbackUrlRef.current || proxyRequestInFlightRef.current) return;
    proxyRequestInFlightRef.current = true;
    try {
      const response = await fetch(`/api/videos/${videoId}/proxy-url`, { method: "POST" });
      if (response.ok) {
        const json = (await response.json()) as { url: string };
        playbackUrlRef.current = json.url;
        setPlaybackUrl(json.url);
      }
    } finally {
      proxyRequestInFlightRef.current = false;
    }
  }

  function applyStatus(json: Partial<VideoRow> & { status?: string }) {
    if (!json.status) return;
    const previous = statusRef.current;
    statusRef.current = json.status;
    setVideo((current) => (current ? { ...current, ...json } : current));
    const settled = json.status === "READY_FOR_REVIEW" || json.status === "COMPLETE";
    const failed = json.status === "FAILED";
    if (settled && previous && previous !== json.status) {
      setResetting(false);
      void load();
      void loadProxy();
      if (previous === "DETECTING_TAKES" || previous === "TRANSCRIBING" || previous === "DETECTING_EDITS") {
        toast.success("Automatic edits updated");
      }
      return;
    }
    if (failed && previous && previous !== json.status) {
      setResetting(false);
      void load();
      toast.error(json.errorMessage ?? "Re-analysis failed");
      return;
    }
    void loadProxy();
  }

  async function loadWaveform() {
    if (waveform || waveformRequestInFlightRef.current) return;
    waveformRequestInFlightRef.current = true;
    try {
      const response = await fetch(`/api/videos/${videoId}/waveform-url`, { method: "POST" });
      if (!response.ok) return;
      const source = (await response.json()) as { kind: "peaks" | "audio"; url: string };
      const dataResponse = await fetch(source.url);
      if (!dataResponse.ok) return;
      const next =
        source.kind === "peaks"
          ? ((await dataResponse.json()) as WaveformData)
          : waveformPeaksFromPcm16Wav(new Uint8Array(await dataResponse.arrayBuffer()));
      if (Array.isArray(next.peaks) && next.peaks.length > 0) setWaveform(next);
    } catch {
      // Playback and editing remain available if waveform loading fails.
    } finally {
      waveformRequestInFlightRef.current = false;
    }
  }

  useEffect(() => {
    // Initial data loading is intentionally tied to the route identity.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const events = new EventSource(`/api/videos/${videoId}/events`);
    events.onmessage = (event) => {
      try {
        applyStatus(JSON.parse(event.data) as VideoRow);
      } catch {
        /* ignore malformed progress */
      }
    };
    const timer = window.setInterval(() => {
      void fetch(`/api/videos/${videoId}/status`)
        .then((response) => (response.ok ? response.json() : null))
        .then((json) => {
          if (json) applyStatus(json as VideoRow);
        })
        .catch(() => undefined);
    }, 4000);
    return () => {
      events.close();
      window.clearInterval(timer);
    };
  }, [videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  const original = video?.durationMs ?? originalDuration(segments);
  const proposed = proposedDuration(segments);
  const removed = Math.max(0, original - proposed);

  function commitOverride(override: { startMs: number; endMs: number; action: "KEEP" | "REMOVE" }) {
    setHistory((current) => [...current, segments]);
    setFuture([]);
    void fetch(`/api/videos/${videoId}/edit`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "override", override }),
    }).then(() => void load());
  }

  function toggle(index: number) {
    const segment = segments[index];
    if (!segment) return;
    commitOverride({
      startMs: segment.startMs,
      endMs: segment.endMs,
      action: segment.action === "REMOVE" ? "KEEP" : "REMOVE",
    });
  }

  function undo() {
    if (history.length === 0) return;
    setHistory((current) => current.slice(0, -1));
    setFuture((current) => [segments, ...current]);
    void fetch(`/api/videos/${videoId}/edit`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "undo" }),
    }).then(() => void load());
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    const changed = next.find((segment, index) => segments[index]?.action !== segment.action) ?? next[0];
    setFuture((current) => current.slice(1));
    setHistory((current) => [...current, segments]);
    if (changed) {
      commitOverride({ startMs: changed.startMs, endMs: changed.endMs, action: changed.action });
    }
  }

  function seekTo(ms: number) {
    if (videoRef.current) videoRef.current.currentTime = ms / 1000;
    setCurrentMs(ms);
  }

  function onTimeUpdate() {
    const el = videoRef.current;
    if (!el) return;
    let ms = el.currentTime * 1000;
    const hit = segments.find(
      (segment) => segment.action === "REMOVE" && ms >= segment.startMs && ms < segment.endMs,
    );
    if (hit) {
      el.currentTime = hit.endMs / 1000;
      ms = hit.endMs;
    }
    setCurrentMs(ms);
  }

  async function resetAutomaticEdits() {
    setResetting(true);
    setVideo((current) =>
      current
        ? {
            ...current,
            status: "DETECTING_TAKES",
            progress: 65,
            progressMessage: "Re-analysing edits",
            errorMessage: null,
          }
        : current,
    );
    statusRef.current = "DETECTING_TAKES";
    try {
      const response = await fetch(`/api/videos/${videoId}/edit/reanalyse`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
        status?: string;
        progress?: number;
        progressMessage?: string;
      };
      if (!response.ok) {
        toast.error(body.error?.message ?? "Could not reset automatic edits");
        setResetting(false);
        await load();
        return;
      }
      applyStatus({
        status: body.status ?? "DETECTING_TAKES",
        progress: body.progress,
        progressMessage: body.progressMessage ?? "Re-analysing edits",
      });
      toast.message("Re-running automatic edits");
    } catch {
      toast.error("Could not reset automatic edits");
      setResetting(false);
      await load();
    }
  }

  async function startExport() {
    setExporting(true);
    const response = await fetch(`/api/videos/${videoId}/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "HIGH_QUALITY" }),
    });
    if (!response.ok) {
      toast.error("Could not start render");
      setExporting(false);
      return;
    }
    const json = (await response.json()) as { export: { id: string } };
    toast.success("Rendering from the original master");
    pollExport(json.export.id);
  }

  async function downloadExport(exportId: string) {
    const download = await fetch(`/api/exports/${exportId}/download-url`, { method: "POST" });
    if (!download.ok) {
      toast.error("Could not create download link");
      return;
    }
    const body = (await download.json()) as { url: string };
    const link = document.createElement("a");
    link.href = body.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function pollExport(exportId: string) {
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/exports/${exportId}`);
      if (!response.ok) return;
      const json = (await response.json()) as { export: { status: string; id: string } };
      if (json.export.status === "COMPLETE") {
        window.clearInterval(timer);
        setExporting(false);
        setCompletedExportId(exportId);
        await downloadExport(exportId);
        void load();
      }
      if (json.export.status === "FAILED") {
        window.clearInterval(timer);
        setExporting(false);
        toast.error("Render failed");
      }
    }, 2000);
  }

  const ready = video?.status === "READY_FOR_REVIEW" || video?.status === "COMPLETE";
  const sourceColor = useMemo(
    () => ({
      AUTO_SILENCE: "bg-amber-500/30",
      AUTO_RETAKE: "bg-destructive/40",
      AUTO_FILLER: "bg-violet-500/30",
      AUTO_SCRIPT: "bg-emerald-500/30",
      USER: "bg-sky-500/30",
      SYSTEM: "bg-muted",
    }),
    [],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => router.push("/dashboard")}>
          Back
        </Button>
        <Badge variant="outline">{video?.status ?? "…"}</Badge>
      </div>
      <div>
        <h1 className="text-xl font-semibold">{video?.originalFilename}</h1>
        <p className="text-sm text-muted-foreground">
          Original {formatMs(original)} → Edited {formatMs(proposed)} · Removed {formatMs(removed)}
        </p>
      </div>
      {!ready ? (
        <Card className="p-4">
          <div className="mb-2 text-sm">{video?.progressMessage ?? "Processing"}</div>
          <Progress value={video?.progress ?? 0} />
          {video?.errorMessage ? <p className="mt-2 text-sm text-destructive">{video.errorMessage}</p> : null}
        </Card>
      ) : null}
      {video?.scriptPassWarning ? <p className="text-sm text-amber-400">{video.scriptPassWarning}</p> : null}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card className="overflow-hidden">
          {playbackUrl ? (
            <video
              ref={videoRef}
              src={playbackUrl}
              controls
              playsInline
              className="aspect-video w-full bg-black"
              onTimeUpdate={onTimeUpdate}
            />
          ) : (
            <div className="flex aspect-video items-center justify-center text-sm text-muted-foreground">
              Preview appears after analysis
            </div>
          )}
          <PlayerTimeline
            currentMs={currentMs}
            durationMs={original}
            segments={segments}
            waveform={waveform}
            sourceColor={sourceColor}
            onSeek={seekTo}
          />
        </Card>
        <Card className="p-3">
          <div className="mb-2 text-sm font-medium">Transcript / takes</div>
          <ScrollArea className="h-[320px]">
            <div className="space-y-2 pr-2">
              {segments.map((segment, index) => (
                <button
                  key={`${segment.startMs}-${index}`}
                  type="button"
                  onClick={() => seekTo(segment.startMs)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                    segment.action === "REMOVE"
                      ? "border-destructive/40 bg-destructive/10 text-muted-foreground line-through"
                      : "border-border"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">
                      {formatMs(segment.startMs)}–{formatMs(segment.endMs)}
                    </span>
                    <Button size="xs" variant="outline" onClick={(event) => {
                      event.stopPropagation();
                      toggle(index);
                    }}>
                      {segment.action === "REMOVE" ? "Restore" : "Remove"}
                    </Button>
                  </div>
                  <SegmentCopy
                    segment={segment}
                    words={words}
                    expanded={Boolean(expanded[index])}
                    onToggleExpand={() => setExpanded((current) => ({ ...current, [index]: !current[index] }))}
                  />
                </button>
              ))}
            </div>
          </ScrollArea>
        </Card>
      </div>
      <Separator />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void startExport()} disabled={!ready || exporting}>
          Accept edits and render
        </Button>
        {completedExportId ? (
          <Button variant="outline" onClick={() => void downloadExport(completedExportId)}>
            Download raw edit
          </Button>
        ) : null}
        <Button variant="outline" onClick={undo} disabled={history.length === 0}>
          Undo
        </Button>
        <Button variant="outline" onClick={redo} disabled={future.length === 0}>
          Redo
        </Button>
        <Button variant="outline" onClick={() => void resetAutomaticEdits()} disabled={resetting}>
          {resetting ? "Re-running…" : "Reset automatic edits"}
        </Button>
      </div>
    </div>
  );
}

function PlayerTimeline({
  currentMs,
  durationMs,
  segments,
  waveform,
  sourceColor,
  onSeek,
}: {
  currentMs: number;
  durationMs: number;
  segments: EditSegment[];
  waveform?: WaveformData;
  sourceColor: Record<string, string>;
  onSeek: (ms: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    const canvas = canvasRef.current;
    if (!track || !canvas) return;

    const draw = () => {
      const rect = track.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = "#25072f";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#e879f9";
      const peaks = waveform?.peaks ?? [];
      if (peaks.length === 0) {
        context.globalAlpha = 0.28;
        context.fillRect(0, height / 2 - 1, width, 2);
        context.globalAlpha = 1;
        return;
      }
      const center = height / 2;
      for (let x = 0; x < width; x += 1) {
        const from = Math.floor((x / width) * peaks.length);
        const to = Math.max(from + 1, Math.ceil(((x + 1) / width) * peaks.length));
        let peak = 0;
        for (let index = from; index < Math.min(to, peaks.length); index += 1) peak = Math.max(peak, peaks[index] ?? 0);
        const amplitude = Math.max(1, Math.min(center - 2, peak * (center - 2)));
        context.fillRect(x, center - amplitude, 1, amplitude * 2);
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(track);
    return () => observer.disconnect();
  }, [waveform]);

  function seekFromClientX(clientX: number) {
    const track = trackRef.current;
    if (!track || durationMs <= 0) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onSeek(ratio * durationMs);
  }

  return (
    <div className="space-y-2 border-t bg-card p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Timeline</span>
        <span className="font-mono">
          {formatMs(currentMs)} / {formatMs(durationMs)}
        </span>
      </div>
      <div
        ref={trackRef}
        role="slider"
        aria-label="Video timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs)}
        aria-valuenow={Math.round(currentMs)}
        tabIndex={0}
        className="relative h-24 cursor-pointer overflow-hidden rounded-lg border border-fuchsia-400/20 bg-[#25072f]"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromClientX(event.clientX);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromClientX(event.clientX);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") onSeek(Math.max(0, currentMs - 1000));
          if (event.key === "ArrowRight") onSeek(Math.min(durationMs, currentMs + 1000));
        }}
      >
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
        {segments.map((segment, index) => {
          const left = durationMs ? (segment.startMs / durationMs) * 100 : 0;
          const width = durationMs ? ((segment.endMs - segment.startMs) / durationMs) * 100 : 0;
          return (
            <div
              key={`${segment.startMs}-bar-${index}`}
              className={`pointer-events-none absolute inset-y-0 ${
                segment.action === "KEEP" ? "border-b-2 border-emerald-400" : `${sourceColor[segment.source ?? "SYSTEM"]} opacity-60`
              }`}
              style={{ left: `${left}%`, width: `${Math.max(width, 0.4)}%` }}
            />
          );
        })}
        <div
          className="absolute top-0 z-10 h-full w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
          style={{ left: `${durationMs ? Math.min(100, (currentMs / durationMs) * 100) : 0}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <LegendDot className="bg-emerald-500" label="Keep" />
        <LegendDot className="bg-amber-500" label="Silence" />
        <LegendDot className="bg-destructive" label="Retake" />
        <LegendDot className="bg-violet-500" label="Filler" />
        <LegendDot className="bg-emerald-300" label="Script" />
        <LegendDot className="bg-sky-500" label="Manual" />
      </div>
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {label}
    </span>
  );
}

function SegmentCopy({
  segment,
  words,
  expanded,
  onToggleExpand,
}: {
  segment: EditSegment;
  words: Word[];
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const primary = transcriptTextForRange(words, segment.startMs, segment.endMs) || "(silence)";
  const long = primary.length > 140;
  return (
    <div className="mt-1 space-y-1">
      <div className={expanded || !long ? "whitespace-pre-wrap" : "line-clamp-2"}>{primary}</div>
      {segment.reason && segment.reason !== "Retained speech" ? (
        <div className="text-xs text-muted-foreground">{segment.reason}</div>
      ) : null}
      {long ? (
        <button type="button" className="text-xs underline" onClick={onToggleExpand}>
          {expanded ? "Collapse" : "Expand"}
        </button>
      ) : null}
    </div>
  );
}
