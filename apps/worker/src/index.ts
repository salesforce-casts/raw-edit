import { createServer } from "node:http";
import { loadConfig } from "@raw-edit/config";
import { QUEUE_NAMES } from "@raw-edit/contracts";
import { createRedisConnection, createWorker } from "@raw-edit/queue";
import pino from "pino";
import { processAnalyzeVideo } from "./jobs/analyze-video";
import { processTranscribeVideo } from "./jobs/transcribe-video";
import { processDetectAutomaticEdits } from "./jobs/detect-automatic-edits";
import { processRenderExport } from "./jobs/render-export";
import { processDeleteVideo } from "./jobs/delete-video";

process.env.SERVICE_NAME = "worker";
const config = loadConfig();
const logger = pino({ level: config.logLevel, base: { service: "worker" } });
const connection = createRedisConnection(config);

createWorker(QUEUE_NAMES.analysis, async (job) => processAnalyzeVideo(job.data), config.workerConcurrency, connection);
createWorker(QUEUE_NAMES.transcription, async (job) => processTranscribeVideo(job.data), config.workerConcurrency, connection);
createWorker(QUEUE_NAMES.editDetection, async (job) => processDetectAutomaticEdits(job.data), config.workerConcurrency, connection);
createWorker(QUEUE_NAMES.render, async (job) => processRenderExport(job.data), config.renderConcurrency, connection);
createWorker(QUEUE_NAMES.maintenance, async (job) => processDeleteVideo(job.data), 1, connection);

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(Number(process.env.PORT ?? 8787), () => {
  logger.info({ event: "worker.started", port: process.env.PORT ?? 8787 }, "media worker listening");
});
