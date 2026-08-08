import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DialogsModule } from '@modules/dialogs/dialogs.module';
import { DialogsService } from '@modules/dialogs/dialogs.service';
import { LeadEntity } from '@modules/lead/lead.entity';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

describe('DialogsModule (DI)', () => {
  it('поднимается целиком', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DialogsModule] })
      .overrideProvider(getRepositoryToken(LeadEntity))
      .useValue({})
      .overrideProvider(TelegramClientService)
      .useValue({ getClient: () => ({}), getMyId: () => null })
      .compile();

    expect(moduleRef.get(DialogsService)).toBeInstanceOf(DialogsService);

    await moduleRef.close();
  });
});
