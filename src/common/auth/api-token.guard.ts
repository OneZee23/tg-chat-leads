import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Проверка заголовка `x-api-token`. Если API_TOKEN не задан — гвард
 * пропускает всё: по умолчанию мы слушаем 127.0.0.1, и лишний секрет
 * ради локального инструмента только мешает.
 *
 * Задай API_TOKEN, если решишь пробросить порт наружу (ssh -L, ngrok и т.п.).
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  public canActivate(context: ExecutionContext): boolean {
    const expected = process.env.API_TOKEN ?? '';
    if (expected.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request>();
    // /health должен отвечать без токена — иначе любой внешний чек
    // (docker healthcheck, curl в терминале) требует секрет ни за чем.
    if ((req.path ?? '').startsWith('/health')) return true;

    const raw = req.headers['x-api-token'];
    const provided = Array.isArray(raw) ? raw[0] : (raw ?? '');

    if (!safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid api token');
    }
    return true;
  }
}

// timingSafeEqual падает на буферах разной длины, поэтому длину сверяем
// отдельно. Утечка длины токена безобидна.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
