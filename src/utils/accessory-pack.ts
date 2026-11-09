export type AccessoryPack = { units: number; price: number; label: string };

/** Datos públicos estrictos de una presentación. El stock siempre cuenta piezas. */
export function readAccessoryPack(value: unknown): AccessoryPack | null {
  const pack = value as Partial<AccessoryPack> | null;
  if (!pack || !Number.isSafeInteger(pack.units) || Number(pack.units) < 2 || Number(pack.units) > 1000000 || typeof pack.price !== 'number' || !Number.isFinite(pack.price) || Math.round(pack.price * 100) < 1 || pack.price > 9999999999.99) return null;
  if (typeof pack.label !== 'string' || !pack.label.trim() || pack.label.trim().length > 40) return null;
  return { units: Number(pack.units), price: Math.round(pack.price * 100) / 100, label: pack.label.trim() };
}

export function accessoryPackTotal(unitPrice: number, qty: number, pack: AccessoryPack | null): number {
  const count = Math.max(0, Math.floor(qty));
  const unitCents = Math.round(unitPrice * 100);
  if (!pack) return (unitCents * count) / 100;
  return (Math.floor(count / pack.units) * Math.round(pack.price * 100) + (count % pack.units) * unitCents) / 100;
}
