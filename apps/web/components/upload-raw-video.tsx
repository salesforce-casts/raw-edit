"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DESKTOP_UPLOAD_CONCURRENCY,
  MOBILE_UPLOAD_CONCURRENCY,
  MULTIPART_THRESHOLD_BYTES,
  PRESIGN_BATCH_SIZE,
  fileFingerprint,
} from "@raw-edit/core";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBytes, formatSpeed } from "@/lib/utils";
import { deleteUpload, listUploads, saveUpload } from "@/lib/upload-idb";

type UploadStats = {
  filename: string;
  fileSize: number;
  percent: number;
  speed: number;
  uploadedBytes: number;
  resumeHint?: string;
};

function isMobile() {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

async function signParts(sessionId: string, partNumbers: number[]) {
  const response = await fetch(`/api/uploads/${sessionId}/parts/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partNumbers }),
  });
  if (!response.ok) throw new Error("Could not sign upload parts");
  return response.json() as Promise<{ parts: Array<{ partNumber: number; url: string }> }>;
}

async function hashFile(file: File): Promise<string> {
  const worker = new Worker(new URL("../lib/sha256.worker.ts", import.meta.url), { type: "module" });
  const chunkSize = 8 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const buffer = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer();
    worker.postMessage({ type: "chunk", buffer }, [buffer]);
  }
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ sha256: string }>) => {
      worker.terminate();
      resolve(event.data.sha256);
    };
    worker.onerror = (error) => {
      worker.terminate();
      reject(error);
    };
    worker.postMessage({ type: "done" });
  });
}

async function completedFromR2(sessionId: string) {
  const response = await fetch(`/api/uploads/${sessionId}`);
  if (!response.ok) return [];
  const json = (await response.json()) as { completedParts: Array<{ partNumber: number; etag: string }> };
  return json.completedParts.filter((part) => part.etag);
}

export function UploadRawVideo() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stats, setStats] = useState<UploadStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [resumeNotice, setResumeNotice] = useState<string>();
  const concurrency = useMemo(
    () => (isMobile() ? MOBILE_UPLOAD_CONCURRENCY : DESKTOP_UPLOAD_CONCURRENCY),
    [],
  );

  useEffect(() => {
    void (async () => {
      const unfinished = await listUploads();
      if (unfinished.length > 0) {
        setResumeNotice("Unfinished upload found. Re-select the same file to skip parts R2 already has.");
      }
    })();
  }, []);

  async function startUpload(file: File) {
    setBusy(true);
    const started = Date.now();
    const fingerprint = fileFingerprint({ name: file.name, size: file.size, lastModified: file.lastModified });
    setStats({
      filename: file.name,
      fileSize: file.size,
      percent: 0,
      speed: 0,
      uploadedBytes: 0,
      resumeHint: resumeNotice,
    });

    const hashPromise = hashFile(file);
    const unfinished = await listUploads();
    const matching = unfinished.find(
      (item) => item.filename === file.name && item.filesize === file.size && item.lastModified === file.lastModified,
    );

    let videoId: string;
    let sessionId: string;
    let uploadType: "put" | "multipart";
    let putUrl: string | undefined;
    let partSize: number;
    let totalParts: number;
    let providerUploadId: string | undefined;

    if (matching) {
      videoId = matching.videoId;
      sessionId = matching.uploadSessionId;
      partSize = matching.partSize;
      totalParts = Math.ceil(file.size / partSize);
      uploadType = "multipart";
      providerUploadId = matching.r2UploadId;
      toast.message("Resuming from storage. Parts already on R2 will be skipped.");
    } else {
      const created = await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalFilename: file.name,
          mimeType: file.type || "video/quicktime",
          sizeBytes: file.size,
        }),
      });
      if (!created.ok) {
        setBusy(false);
        toast.error("Could not create video");
        return;
      }
      const { video } = (await created.json()) as { video: { id: string } };
      videoId = video.id;
      const init = await fetch(`/api/videos/${video.id}/upload/init`, { method: "POST" });
      if (!init.ok) {
        setBusy(false);
        toast.error("Could not start upload");
        return;
      }
      const session = (await init.json()) as {
        session: { id: string; providerUploadId?: string | null; partSizeBytes: number; totalParts: number };
        putUrl?: string;
        uploadType: "put" | "multipart";
      };
      sessionId = session.session.id;
      uploadType = session.uploadType;
      putUrl = session.putUrl;
      partSize = session.session.partSizeBytes;
      totalParts = session.session.totalParts;
      providerUploadId = session.session.providerUploadId ?? undefined;
    }

    let uploadedBytes = 0;
    const update = (bytes: number) => {
      uploadedBytes = bytes;
      const elapsed = Math.max(1, (Date.now() - started) / 1000);
      setStats({
        filename: file.name,
        fileSize: file.size,
        percent: Math.round((bytes / file.size) * 100),
        speed: bytes / elapsed,
        uploadedBytes: bytes,
      });
    };

    const abortController = new AbortController();
    const onVisible = () => {
      if (document.visibilityState === "visible" && uploadType === "multipart") {
        void completedFromR2(sessionId);
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    try {
      if (uploadType === "put" && putUrl) {
        const response = await fetch(putUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "video/quicktime" },
          signal: abortController.signal,
        });
        if (!response.ok) throw new Error("PUT upload failed");
        update(file.size);
      } else {
        const held = await completedFromR2(sessionId);
        const completed = new Map(held.map((part) => [part.partNumber, part.etag]));
        uploadedBytes = [...completed.keys()].reduce((sum, partNumber) => {
          const start = (partNumber - 1) * partSize;
          return sum + Math.min(partSize, file.size - start);
        }, 0);
        update(uploadedBytes);
        await saveUpload({
          videoId,
          uploadSessionId: sessionId,
          r2UploadId: providerUploadId,
          filename: file.name,
          filesize: file.size,
          lastModified: file.lastModified,
          fingerprint,
          partSize,
          completedParts: [...completed.entries()].map(([partNumber, etag]) => ({ partNumber, etag })),
          createdAt: Date.now(),
        });

        const pending = Array.from({ length: totalParts }, (_, index) => index + 1).filter(
          (partNumber) => !completed.has(partNumber),
        );
        for (let i = 0; i < pending.length; i += PRESIGN_BATCH_SIZE) {
          if (document.visibilityState === "hidden") {
            const latest = await completedFromR2(sessionId);
            for (const part of latest) completed.set(part.partNumber, part.etag);
          }
          const batch = pending.slice(i, i + PRESIGN_BATCH_SIZE).filter((partNumber) => !completed.has(partNumber));
          if (batch.length === 0) continue;
          const signed = await signParts(sessionId, batch);
          const queue = [...signed.parts];
          const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
            while (queue.length > 0) {
              const part = queue.shift();
              if (!part) return;
              const start = (part.partNumber - 1) * partSize;
              const end = Math.min(file.size, start + partSize);
              const blob = file.slice(start, end);
              let attempt = 0;
              let etag = "";
              while (attempt < 3) {
                const response = await fetch(part.url, { method: "PUT", body: blob, signal: abortController.signal });
                if (response.ok) {
                  etag = (response.headers.get("ETag") ?? "").replaceAll('"', "");
                  break;
                }
                attempt += 1;
                await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
              }
              if (!etag) throw new Error(`Part ${part.partNumber} failed`);
              completed.set(part.partNumber, etag);
              await fetch(`/api/uploads/${sessionId}/parts/complete`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ partNumber: part.partNumber, etag, sizeBytes: blob.size }),
              });
              uploadedBytes += blob.size;
              update(Math.min(file.size, uploadedBytes));
              await saveUpload({
                videoId,
                uploadSessionId: sessionId,
                r2UploadId: providerUploadId,
                filename: file.name,
                filesize: file.size,
                lastModified: file.lastModified,
                fingerprint,
                partSize,
                completedParts: [...completed.entries()].map(([partNumber, value]) => ({
                  partNumber,
                  etag: value,
                })),
                createdAt: Date.now(),
              });
            }
          });
          await Promise.all(workers);
        }
      }

      const sha256 = await hashPromise;
      const complete = await fetch(`/api/uploads/${sessionId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha256, fingerprint }),
      });
      if (!complete.ok) throw new Error("Could not finalize upload");
      await deleteUpload(sessionId);
      toast.success("Upload complete. Analysis started.");
      router.push(`/videos/${videoId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      document.removeEventListener("visibilitychange", onVisible);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mov,.mp4,.m4v,.qt"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void startUpload(file);
        }}
      />
      <Button
        size="lg"
        className="h-14 w-full text-base"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        Upload Raw Video
      </Button>
      {resumeNotice ? <p className="text-sm text-amber-400">{resumeNotice}</p> : null}
      {stats ? (
        <div className="rounded-xl border border-border bg-card p-4 text-sm">
          <div className="font-medium">{stats.filename}</div>
          <div className="mt-1 text-muted-foreground">
            {formatBytes(stats.fileSize)} · {formatBytes(stats.uploadedBytes)} uploaded · {formatSpeed(stats.speed)}
          </div>
          <Progress value={stats.percent} className="mt-3" />
          <div className="mt-2 text-muted-foreground">{stats.percent}%</div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Choose from Photos or Files. Files over {formatBytes(MULTIPART_THRESHOLD_BYTES)} use resumable multipart
          upload directly to private storage. Refreshing the page requires picking the same file again.
        </p>
      )}
    </div>
  );
}
