import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';

@Injectable()
export class WebhookService {
  private hmac(body: string) {
    const secret = process.env.SYNC_SECRET || '';
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  async emit(event: 'product.listed' | 'product.updated' | 'product.sold', payload: any) {
    const url = process.env.CATALOG_SYNC_URL;
    if (!url) return;
    const body = JSON.stringify({ event, product: payload });
    const signature = this.hmac(body);
    const idem = crypto.randomUUID();
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature,
        'x-idempotency-key': idem,
      },
      body,
    }).catch(() => {});
  }
}
