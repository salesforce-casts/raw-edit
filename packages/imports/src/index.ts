import { lookup } from "node:dns/promises";
import { AppError, isBlockedIp, type CloudImportProvider, type CloudImportResult } from "@raw-edit/core";

async function assertPublicHostname(hostname: string) {
  const records = await lookup(hostname, { all: true });
  if (records.length === 0) throw new AppError("IMPORT_BLOCKED", "Could not resolve import host", 400, true);
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new AppError("IMPORT_BLOCKED", "Import URL points at a private address", 400, true);
    }
  }
}

export function createUrlImportProvider(): CloudImportProvider {
  return {
    async resolve(input) {
      let parsed: URL;
      try {
        parsed = new URL(input.url);
      } catch {
        throw new AppError("IMPORT_BLOCKED", "Invalid import URL", 400, true);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new AppError("IMPORT_BLOCKED", "Only http(s) import URLs are allowed", 400, true);
      }
      await assertPublicHostname(parsed.hostname);
      const filename = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "import.mp4");
      const result: CloudImportResult = {
        filename,
        mimeType: "video/mp4",
        sourceUrl: parsed.toString(),
      };
      return result;
    },
  };
}

export function createCloudImportProvider(): CloudImportProvider {
  const url = createUrlImportProvider();
  return {
    async resolve(input) {
      if (!input.provider || input.provider === "url") return url.resolve(input);
      throw new AppError("IMPORT_BLOCKED", `Cloud import for ${input.provider} is not enabled in v1`, 501, true);
    },
  };
}
