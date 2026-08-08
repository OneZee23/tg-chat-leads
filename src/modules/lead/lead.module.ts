import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeadController } from '@modules/lead/lead.controller';
import { LeadEntity } from '@modules/lead/lead.entity';
import { LeadService } from '@modules/lead/lead.service';

@Module({
  imports: [TypeOrmModule.forFeature([LeadEntity])],
  controllers: [LeadController],
  providers: [LeadService],
  exports: [LeadService],
})
export class LeadModule {}
