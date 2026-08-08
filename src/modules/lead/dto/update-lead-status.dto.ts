import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { LEAD_STATUSES, LeadStatus } from '@modules/lead/lead.entity';

export class UpdateLeadStatusDto {
  @IsIn(LEAD_STATUSES as unknown as string[])
  public readonly status: LeadStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public readonly note?: string;
}
