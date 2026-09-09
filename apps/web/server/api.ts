import { NextResponse } from "next/server";
import { AppError } from "@raw-edit/contracts";
import { logger } from "./logger";

export function jsonError(error: unknown) {
  if (error instanceof AppError) {
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  logger.error({ err: error instanceof Error ? error.message : "unknown" }, "unhandled_api_error");
  return NextResponse.json(
    { error: { code: "INVALID_MEDIA", message: "Something went wrong" } },
    { status: 500 },
  );
}

export function requestId() {
  return crypto.randomUUID();
}
