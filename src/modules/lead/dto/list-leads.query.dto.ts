import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LEAD_STATUSES, LeadStatus } from '@modules/lead/lead.entity';

const toBool = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value;

export class ListLeadsQueryDto {
  @IsOptional()
  @IsIn(LEAD_STATUSES as unknown as string[])
  public readonly status?: LeadStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  public readonly minScore?: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  public readonly chat?: string;

  /** Только те, кому можно написать по @нику (без ника писать некуда). */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  public readonly hasUsername?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public readonly search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  public readonly limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public readonly offset?: number;
}
