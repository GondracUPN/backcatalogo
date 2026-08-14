import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';

@Injectable()
export class WebhookService {
  async emit(event: 'product.listed' | 'product.updated' | 'product.sold', payload: any) {
    const url = process.env.CATALOG_SYNC_URL;
    if (!url) return;
    const body = JSON.stringify({ event, product: payload });
    const idem = crypto.randomUUID();
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-idempotency-key': idem,
      },
      body,
    }).catch(() => {});
  }
}
