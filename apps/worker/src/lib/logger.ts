import pino from 'pino';
import { env } from './env.js';

/**
 * Structured logs. Railway captures stdout, so JSON in production and something
 * readable locally.
 */
export const logger = pino({
  level: env.logLevel,
  base: { worker: env.workerId },
  ...(env.nodeEnv === 'development'
    ? {
        transport: {
          target: 'pino/file',
          options: { destination: 1 },
        },
      }
    : {}),
});

export type Logger = typeof logger;
