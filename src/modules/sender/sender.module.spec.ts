import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LeadEntity } from '@modules/lead/lead.entity';
import { SendAttemptEntity } from '@modules/sender/send-attempt.entity';
import { SendSchedulerService } from '@modules/sender/send-scheduler.service';
import { SenderModule } from '@modules/sender/sender.module';
import { SenderService } from '@modules/sender/sender.service';
import { TelegramClientService } from '@modules/telegram/telegram-client.service';

describe('SenderModule (DI)', () => {
  it('поднимается целиком, включая планировщик и журнал попыток', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SenderModule] })
      .overrideProvider(getRepositoryToken(LeadEntity))
      .useValue({})
      .overrideProvider(getRepositoryToken(SendAttemptEntity))
      .useValue({})
      .overrideProvider(TelegramClientService)
      .useValue({ getClient: () => ({}), tryGetClient: () => null, getMyId: () => null })
      .compile();

    expect(moduleRef.get(SenderService)).toBeInstanceOf(SenderService);
    expect(moduleRef.get(SendSchedulerService)).toBeInstanceOf(SendSchedulerService);

    await moduleRef.close();
  });
});
