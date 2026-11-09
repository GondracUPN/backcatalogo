import { ServiceUnavailableException } from '@nestjs/common';

/** Confirma el retiro en Servicios antes de ocultar la ficha local. Es idempotente. */
export async function withdrawAccessoryFromServices(sku: string) {
  if (!/^acc-(?:ref-\d+-[a-f0-9]{16}|lot-\d+)$/.test(sku)) return;
  const salesUrl = String(process.env.SERVICES_SALES_SYNC_URL || '').trim();
  const base = String(process.env.SERVICES_API_BASE || process.env.UPSTREAM_API_BASE || '').trim().replace(/\/$/, '');
  const url = /\/integrations\/catalog-sales\/events\/?$/.test(salesUrl)
    ? salesUrl.replace(/\/integrations\/catalog-sales\/events\/?$/, '/integrations/catalog-accessories/withdraw')
    : base ? `${base}/integrations/catalog-accessories/withdraw` : '';
  const secret = String(process.env.CATALOG_SYNC_SECRET || '').trim();
  if (!url || !secret) throw new ServiceUnavailableException('Falta configurar la conexión con Servicios para retirar el accesorio.');
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-secret': secret },
      body: JSON.stringify({ sku }), signal: AbortSignal.timeout(8000),
    });
    const result = await response.json() as { ok?: boolean; seleccionado?: boolean };
    if (!response.ok || result?.ok !== true || result?.seleccionado !== false) throw new Error('retiro no confirmado');
  } catch {
    throw new ServiceUnavailableException('No se pudo confirmar el retiro en Servicios. El accesorio sigue en inventario; vuelve a intentarlo.');
  }
}
