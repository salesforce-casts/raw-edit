"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { EditSegment, Word } from "@raw-edit/contracts";
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

  useEffect(() => {
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
  }, [videoId]);

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
  }

  function onTimeUpdate() {
    const el = videoRef.current;
    if (!el) return;
    const currentMs = el.currentTime * 1000;
    const hit = segments.find(
      (segment) => segment.action === "REMOVE" && currentMs >= segment.startMs && currentMs < segment.endMs,
    );
    if (hit) el.currentTime = hit.endMs / 1000;
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
      <Card className="p-3">
        <div className="mb-2 text-sm font-medium">Timeline</div>
        <div className="relative h-16 overflow-hidden rounded-lg bg-muted">
          {segments.map((segment, index) => {
            const left = original ? (segment.startMs / original) * 100 : 0;
            const width = original ? ((segment.endMs - segment.startMs) / original) * 100 : 0;
            return (
              <div
                key={`${segment.startMs}-bar-${index}`}
                className={`absolute top-2 h-8 rounded-sm ${
                  segment.action === "KEEP" ? "bg-primary/70" : sourceColor[segment.source ?? "SYSTEM"]
                }`}
                style={{ left: `${left}%`, width: `${Math.max(width, 0.4)}%` }}
              />
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>Keep</span>
          <span>Silence</span>
          <span>Retake</span>
          <span>Script</span>
          <span>Manual</span>
        </div>
      </Card>
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
