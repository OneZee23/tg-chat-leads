import { Module } from '@nestjs/common';
import { LoggerModule as PinoModule } from 'nestjs-pino';

/**
 * Инструмент ручной, смотрим логи глазами в терминале — поэтому
 * pino-pretty по умолчанию. Если однажды захочется гонять это на сервере,
 * поставь LOG_PRETTY=false и получишь обычный JSON на stdout.
 */
const pretty = process.env.LOG_PRETTY !== 'false';

@Module({
  imports: [
    PinoModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        base: { app: 'teach-track-leadgen' },
        timestamp: () => `,"t":"${new Date().toISOString()}"`,
        formatters: {
          level(label: string) {
            return { level: label };
          },
        },
        transport: pretty
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                singleLine: true,
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname,app',
              },
            }
          : undefined,
        autoLogging: {
          ignore: (req: { url?: string }) => (req.url ?? '').startsWith('/health'),
        },
      },
    }),
  ],
})
export class LoggerModule {}
