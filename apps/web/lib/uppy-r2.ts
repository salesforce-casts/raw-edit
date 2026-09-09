import Uppy from "@uppy/core";
import AwsS3 from "@uppy/aws-s3";
import { MULTIPART_THRESHOLD_BYTES } from "@raw-edit/contracts";

type InitResult = {
  session: { id: string; providerUploadId?: string | null; partSizeBytes: number };
  putUrl?: string;
};

export function createR2Uppy(input: { session: InitResult; onProgress: (percent: number) => void }) {
  const uppy = new Uppy({
    autoProceed: false,
    restrictions: { maxNumberOfFiles: 1, allowedFileTypes: ["video/*", ".mov", ".mp4", ".m4v"] },
  });

  uppy.use(
    AwsS3,
    {
      shouldUseMultipart(file: { size?: number | null }) {
        return (file.size ?? 0) >= MULTIPART_THRESHOLD_BYTES;
      },
      async getUploadParameters() {
        if (!input.session.putUrl) throw new Error("Missing signed PUT URL");
        return { method: "PUT" as const, url: input.session.putUrl };
      },
      async createMultipartUpload() {
        return {
          uploadId: input.session.session.providerUploadId ?? input.session.session.id,
          key: input.session.session.id,
        };
      },
      async signPart(_file: unknown, partData: { partNumber: number }) {
        const response = await fetch(`/api/uploads/${input.session.session.id}/parts/sign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ partNumbers: [partData.partNumber] }),
        });
        const json = (await response.json()) as { parts: Array<{ url: string }> };
        return { url: json.parts[0].url };
      },
      async completeMultipartUpload() {
        await fetch(`/api/uploads/${input.session.session.id}/complete`, { method: "POST" });
        return { location: input.session.session.id };
      },
      async abortMultipartUpload() {
        await fetch(`/api/uploads/${input.session.session.id}`, { method: "DELETE" });
      },
      async listParts() {
        const response = await fetch(`/api/uploads/${input.session.session.id}`);
        const json = (await response.json()) as {
          completedParts: Array<{ partNumber: number; etag: string | null }>;
        };
        return json.completedParts
          .filter((part) => part.etag)
          .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag as string }));
      },
    } as never,
  );

  uppy.on("upload-progress", (_file, progress) => {
    const percent = progress.bytesTotal ? Math.round((progress.bytesUploaded / progress.bytesTotal) * 100) : 0;
    input.onProgress(percent);
  });

  return uppy;
}
