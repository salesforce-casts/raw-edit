import { loadConfig } from "@raw-edit/config";
import { getDb } from "@raw-edit/db";
import { createR2Storage } from "@raw-edit/storage";
import { createBullmqQueue } from "@raw-edit/queue";
import { createNoopPaymentProvider } from "@raw-edit/ai";
import { createCloudImportProvider } from "@raw-edit/imports";

export function createWebContainer() {
  loadConfig();
  return {
    db: getDb(),
    storage: createR2Storage(),
    queue: createBullmqQueue(),
    payment: createNoopPaymentProvider(),
    imports: createCloudImportProvider(),
  };
}

export type WebContainer = ReturnType<typeof createWebContainer>;

let cached: WebContainer | undefined;

export function getWebContainer(): WebContainer {
  cached ??= createWebContainer();
  return cached;
}
