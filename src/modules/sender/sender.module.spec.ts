import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LeadEntity } from '@modules/lead/lead.entity';
import { SenderModule } from '@modules/sender/sender.module';
import { SenderService } from '@modules/sender/sender.service';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

describe('SenderModule (DI)', () => {
  it('поднимается целиком', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SenderModule] })
      .overrideProvider(getRepositoryToken(LeadEntity))
      .useValue({})
      .overrideProvider(TelegramClientService)
      .useValue({ getClient: () => ({}), getMyId: () => null })
      .compile();

    expect(moduleRef.get(SenderService)).toBeInstanceOf(SenderService);

    await moduleRef.close();
  });
});
