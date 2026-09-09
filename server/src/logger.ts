import winston from 'winston';
import Transport from 'winston-transport';
import { config } from './config.js';

const textFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`),
);

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
);

/**
 * Last warnings and errors, kept in memory for the admin diagnostics export
 * (V08.4). Messages only, no metadata: tokens never reach a log line (V02.4),
 * and file paths inside messages are trimmed to their last segment by the
 * diagnostics route.
 */
export interface RecentLogEntry {
  level: string;
  message: string;
  at: string;
}
const RECENT_LIMIT = 50;
const recent: RecentLogEntry[] = [];

const LEVEL = Symbol.for('level');

class RecentTransport extends Transport {
  log(info: { level: string; message: unknown; [LEVEL]?: string }, next: () => void): void {
    // The text format colorizes info.level; the symbol keeps the raw name.
    const level = info[LEVEL] ?? info.level;
    if (level === 'warn' || level === 'error') {
      recent.push({
        level,
        message: String(info.message).slice(0, 500),
        at: new Date().toISOString(),
      });
      if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
    }
    next();
  }
}

export function getRecentLog(): RecentLogEntry[] {
  return recent.slice();
}

export const logger = winston.createLogger({
  level: config.logLevel,
  format: config.logFormat === 'json' ? jsonFormat : textFormat,
  defaultMeta: {
    service: 'audioserver',
    environment: config.nodeEnv,
  },
  transports: [new winston.transports.Console(), new RecentTransport({ level: 'warn' })],
});
