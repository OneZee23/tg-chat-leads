import { DatabaseConfig } from '@infra/database/database.config';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [
        {
          module: class DatabaseConfigModule {},
          providers: [DatabaseConfig],
          exports: [DatabaseConfig],
        },
      ],
      inject: [DatabaseConfig],
      useFactory: (config: DatabaseConfig) => ({
        type: 'postgres' as const,
        host: config.host,
        port: config.port,
        database: config.database,
        username: config.username,
        password: config.password,
        entities: [`${__dirname}/../../**/*.entity.{js,ts}`],
        migrations: [`${__dirname}/../../migrations/*.{js,ts}`],
        migrationsRun: config.migrate,
        synchronize: config.sync,
        logging: config.log,
        // Дедлайны — тот же урок, что стоил TeachTrack'у недель молчаливого
        // простоя напоминаний: запрос в оборванный сокет не завершается
        // никогда, и «висящий» скан выглядит как работающий.
        extra: {
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
          options: '-c timezone=UTC',
          statement_timeout: 30_000,
          query_timeout: 35_000,
          lock_timeout: 10_000,
          idle_in_transaction_session_timeout: 60_000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10_000,
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
