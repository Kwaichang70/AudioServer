import winston from 'winston';
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

export const logger = winston.createLogger({
  level: config.logLevel,
  format: config.logFormat === 'json' ? jsonFormat : textFormat,
  defaultMeta: {
    service: 'audioserver',
    environment: config.nodeEnv,
  },
  transports: [new winston.transports.Console()],
});
