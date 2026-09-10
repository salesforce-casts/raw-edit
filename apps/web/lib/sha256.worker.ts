import { IncrementalSha256 } from "@raw-edit/core";

const hasher = new IncrementalSha256();

self.onmessage = (event: MessageEvent<{ type: "chunk" | "done"; buffer?: ArrayBuffer }>) => {
  if (event.data.type === "chunk" && event.data.buffer) {
    hasher.update(new Uint8Array(event.data.buffer));
    return;
  }
  if (event.data.type === "done") {
    self.postMessage({ sha256: hasher.digestHex() });
  }
};
