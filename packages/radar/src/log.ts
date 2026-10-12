import pino from 'pino';

export const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: undefined });
export type Logger = typeof log;
