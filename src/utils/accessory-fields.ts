import { readAccessoryPack } from './accessory-pack';
import { BadRequestException } from '@nestjs/common';
import type { StagedProduct } from '../entities/staged-product.entity';

// Los accesorios usan la condición y la presentación existentes, sin cambiar
// sus valores compartidos con los equipos. Los costos quedan en notes.valor.
export function accessoryFields(body: any, previousNotes: any = {}): Partial<StagedProduct> {
  const patch: Partial<StagedProduct> = {};
  const rawPack = body.accessoryPack !== undefined ? body.accessoryPack : previousNotes.accessoryPack;
  let cleanNotes = previousNotes;
  if (rawPack !== undefined) {
    const pack = rawPack === null ? null : readAccessoryPack(rawPack);
    if (rawPack !== null && !pack) throw new BadRequestException('Presentación inválida: indica cantidad entera desde 2, nombre y precio positivo');
    cleanNotes = { ...previousNotes, accessoryPack: pack };
    patch.notes = JSON.stringify(cleanNotes);
  }
  if (body.accessoryState !== undefined) {
    if (!['Sellado', 'Usado', 'Open Box'].includes(body.accessoryState)) {
      throw new BadRequestException('Estado de accesorio inválido');
    }
    patch.product_condition = body.accessoryState === 'Sellado' ? 'Nuevo' : body.accessoryState;
    patch.presentation = body.accessoryState === 'Sellado' ? 'sellado' : null;
  }
  if (body.accessoryCosts !== undefined) {
    const money = (value: unknown) => {
      if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
        throw new BadRequestException('Costo requerido');
      }
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 9999999999.99) {
        throw new BadRequestException('Costo inválido');
      }
      return Math.round(number * 100);
    };
    const purchase = money(body.accessoryCosts?.purchase);
    const shipping = money(body.accessoryCosts?.shipping);
    if (purchase + shipping > 999999999999) throw new BadRequestException('Costo total inválido');
    patch.notes = JSON.stringify({ ...cleanNotes, valor: {
      ...previousNotes.valor,
      costoProducto: purchase / 100,
      costoEnvio: shipping / 100,
      costoTotal: (purchase + shipping) / 100,
      moneda: 'PEN',
    } });
  }
  return patch;
}
