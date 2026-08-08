import { DataSource } from 'typeorm';

// Отдельный datasource только для CLI: миграции генерим/катаем руками,
// приложение в рантайме собирает конфиг само (см. infra/database).
// Читает те же DB_* из .env — dotenv подключается в typeorm.sh.
export const connectionSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  logging: true,
  synchronize: false,
  migrationsRun: false,
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
});

export default connectionSource;
