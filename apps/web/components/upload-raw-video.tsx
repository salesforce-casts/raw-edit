"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DESKTOP_UPLOAD_CONCURRENCY,
  MOBILE_UPLOAD_CONCURRENCY,
  MULTIPART_PART_SIZE_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  PRESIGN_BATCH_SIZE,
} from "@raw-edit/contracts";
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
  resolution?: string;
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

export function UploadRawVideo() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stats, setStats] = useState<UploadStats | null>(null);
  const [busy, setBusy] = useState(false);
  const concurrency = useMemo(
    () => (isMobile() ? MOBILE_UPLOAD_CONCURRENCY : DESKTOP_UPLOAD_CONCURRENCY),
    [],
  );

  useEffect(() => {
    void resumeIfNeeded();
  }, []);

  async function resumeIfNeeded() {
    const unfinished = await listUploads();
    if (unfinished.length === 0) return;
    toast.message("Unfinished upload found. Re-select the same file to resume.");
  }

  async function startUpload(file: File) {
    setBusy(true);
    const started = Date.now();
    setStats({
      filename: file.name,
      fileSize: file.size,
      percent: 0,
      speed: 0,
      uploadedBytes: 0,
    });

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

    try {
      if (session.uploadType === "put" && session.putUrl) {
        const response = await fetch(session.putUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "video/quicktime" },
        });
        if (!response.ok) throw new Error("PUT upload failed");
        update(file.size);
      } else {
        const partSize = session.session.partSizeBytes ?? MULTIPART_PART_SIZE_BYTES;
        const totalParts = session.session.totalParts ?? Math.ceil(file.size / partSize);
        const completed = new Map<number, string>();
        await saveUpload({
          videoId: video.id,
          uploadSessionId: session.session.id,
          r2UploadId: session.session.providerUploadId ?? undefined,
          filename: file.name,
          filesize: file.size,
          lastModified: file.lastModified,
          partSize,
          completedParts: [],
          createdAt: Date.now(),
        });

        const pending = Array.from({ length: totalParts }, (_, index) => index + 1);
        for (let i = 0; i < pending.length; i += PRESIGN_BATCH_SIZE) {
          const batch = pending.slice(i, i + PRESIGN_BATCH_SIZE);
          const signed = await signParts(session.session.id, batch);
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
                const response = await fetch(part.url, { method: "PUT", body: blob });
                if (response.ok) {
                  etag = (response.headers.get("ETag") ?? "").replaceAll('"', "");
                  break;
                }
                attempt += 1;
                await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
              }
              if (!etag) throw new Error(`Part ${part.partNumber} failed`);
              completed.set(part.partNumber, etag);
              await fetch(`/api/uploads/${session.session.id}/parts/complete`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ partNumber: part.partNumber, etag, sizeBytes: blob.size }),
              });
              uploadedBytes += blob.size;
              update(Math.min(file.size, uploadedBytes));
              await saveUpload({
                videoId: video.id,
                uploadSessionId: session.session.id,
                r2UploadId: session.session.providerUploadId ?? undefined,
                filename: file.name,
                filesize: file.size,
                lastModified: file.lastModified,
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

      const complete = await fetch(`/api/uploads/${session.session.id}/complete`, { method: "POST" });
      if (!complete.ok) throw new Error("Could not finalize upload");
      await deleteUpload(session.session.id);
      toast.success("Upload complete. Analysis started.");
      router.push(`/videos/${video.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
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
          upload directly to private storage.
        </p>
      )}
    </div>
  );
}
