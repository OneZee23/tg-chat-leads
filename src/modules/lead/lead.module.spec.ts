import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LeadImportService } from '@modules/lead/lead-import.service';
import { LeadEntity } from '@modules/lead/lead.entity';
import { LeadModule } from '@modules/lead/lead.module';
import { LeadService } from '@modules/lead/lead.service';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

/**
 * Проверка графа зависимостей, а не логики: ручной импорт добавил
 * LeadModule зависимость от TelegramModule, а LeadModule импортируют почти
 * все остальные. Юнит-тесты собирают сервисы руками, мимо контейнера, и
 * цикл или забытый экспорт всплыли бы только на старте приложения.
 *
 * compile() инстанцирует провайдеры, но не зовёт onModuleInit — ни в базу,
 * ни в Telegram тест не ходит.
 */
describe('LeadModule (DI)', () => {
  it('поднимается целиком и раздаёт импортёр', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [LeadModule] })
      .overrideProvider(getRepositoryToken(LeadEntity))
      .useValue({})
      .overrideProvider(TelegramClientService)
      .useValue({ getClient: () => ({}), tryGetClient: () => null, getMyId: () => null })
      .compile();

    expect(moduleRef.get(LeadService)).toBeInstanceOf(LeadService);
    expect(moduleRef.get(LeadImportService)).toBeInstanceOf(LeadImportService);

    await moduleRef.close();
  });
});
