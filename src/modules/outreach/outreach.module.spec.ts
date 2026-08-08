import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LeadEntity } from '@modules/lead/lead.entity';
import { OutreachModule } from '@modules/outreach/outreach.module';
import { OutreachService } from '@modules/outreach/outreach.service';
import { ScanStateEntity } from '@modules/scanner/scan-state.entity';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

/**
 * OutreachModule связывает три модуля сразу, и именно на таких стыках
 * ломается DI: забыл exports — узнаешь на проде. Здесь узнаём в тесте.
 */
describe('OutreachModule (DI)', () => {
  it('получает ScannerService и DialogsService из чужих модулей', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [OutreachModule] })
      .overrideProvider(getRepositoryToken(LeadEntity))
      .useValue({})
      .overrideProvider(getRepositoryToken(ScanStateEntity))
      .useValue({})
      .overrideProvider(TelegramClientService)
      .useValue({ getClient: () => ({}), tryGetClient: () => null, getMyId: () => null })
      .compile();

    expect(moduleRef.get(OutreachService)).toBeInstanceOf(OutreachService);

    await moduleRef.close();
  });
});
