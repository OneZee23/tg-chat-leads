import { DataSource } from 'typeorm';

// Отдельный datasource только для CLI: миграции генерим/катаем руками,
// приложение в рантайме собирает конфиг само (см. infra/database).
// Читает те же DB_* из .env — dotenv подключается в typeorm.sh.
//
// РОВНО ОДИН экспорт DataSource на файл. Если добавить рядом
// `export default connectionSource`, CLI падает с «Given data source file
// must contain only one export of DataSource instance» — он не выбирает
// между экспортами, а считает их.
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
