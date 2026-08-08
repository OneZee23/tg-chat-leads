import { OnModuleInit } from '@nestjs/common';
import { validateSync } from 'class-validator';

/**
 * Базовый класс для конфигов. Значения читаются лениво из process.env
 * (см. @UseEnv), а на onModuleInit прогоняется class-validator — то есть
 * приложение падает на старте, а не через час работы на первом обращении
 * к незаданной переменной.
 */
export class ConfigFragment implements OnModuleInit {
  public onModuleInit(): void {
    const errors = validateSync(this);

    if (errors.length > 0) {
      const errorList = errors.map(String).join('\n');

      throw new Error(`Failed to validate settings: \n${errorList}`);
    }
  }
}
