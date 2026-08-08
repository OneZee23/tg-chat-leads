// dotenv первым импортом: конфиги читают process.env лениво, но
// TypeORM-датасорс и валидация конфигов срабатывают уже на старте модулей.
import 'dotenv/config';
import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';

// Урок из прода TeachTrack: необработанный reject в Node 18+ по умолчанию
// роняет процесс, и без этого лога ты не узнаешь, что именно упало.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(PinoLogger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  // Без этого onModuleDestroy не вызывается по Ctrl+C, и MTProto-клиент
  // остаётся с живыми таймерами — процесс не завершается.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3010);
  const host = process.env.HOST ?? '127.0.0.1';

  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`teach-track-leadgen listening on http://${host}:${port}`);
}

void bootstrap();
