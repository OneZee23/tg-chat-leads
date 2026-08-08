import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LeadEntity } from '@modules/lead/lead.entity';
import { LeadService } from '@modules/lead/lead.service';
import { ScanStateEntity } from '@modules/scanner/scan-state.entity';
import { ScannerModule } from '@modules/scanner/scanner.module';
import { ScannerService } from '@modules/scanner/scanner.service';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

/**
 * Проверка графа зависимостей, а не логики.
 *
 * Урок из TeachTrack: юнит-тесты собирают сервисы руками, мимо контейнера,
 * поэтому DI-цикл или забытый провайдер всплывают только на проде. Здесь мы
 * поднимаем настоящий ScannerModule (со всеми его импортами) и подменяем
 * только внешний мир — репозитории и MTProto-клиент.
 *
 * compile() инстанцирует провайдеры, но не зовёт onModuleInit, так что
 * ни в базу, ни в Telegram тест не ходит.
 */
describe('ScannerModule (DI)', () => {
  it('поднимается целиком и раздаёт зависимости', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ScannerModule] })
      .overrideProvider(getRepositoryToken(ScanStateEntity))
      .useValue({})
      .overrideProvider(getRepositoryToken(LeadEntity))
      .useValue({})
      .overrideProvider(TelegramClientService)
      .useValue({ getClient: () => ({}), getMyId: () => null })
      .compile();

    expect(moduleRef.get(ScannerService)).toBeInstanceOf(ScannerService);
    // LeadService приходит из LeadModule через exports — если экспорт
    // потеряется, тест упадёт здесь, а не в проде на первом сообщении.
    expect(moduleRef.get(LeadService, { strict: false })).toBeInstanceOf(LeadService);

    await moduleRef.close();
  });
});
