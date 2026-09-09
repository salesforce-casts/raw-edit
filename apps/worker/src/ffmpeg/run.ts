import { spawn } from "node:child_process";
import { loadConfig } from "@raw-edit/config";

export function runCommand(bin: string, args: string[], onStdout?: (chunk: string) => void) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

export function ffmpeg(args: string[], onStdout?: (chunk: string) => void) {
  return runCommand(loadConfig().ffmpegPath, args, onStdout);
}

export function ffprobe(args: string[]) {
  return runCommand(loadConfig().ffprobePath, args);
}
