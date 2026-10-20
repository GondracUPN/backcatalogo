import { BadRequestException } from '@nestjs/common';
import { ownerUserIdForStaff, StaffPayload } from './staff-auth';

export type SalesScope = { owner: number | null; all: boolean };

export function scopeForStaff(
  staff: StaffPayload,
  requestedOwner?: string,
): SalesScope {
  if (String(staff.role).toUpperCase() !== 'ADMIN') {
    return { owner: ownerUserIdForStaff(staff), all: false };
  }
  if (requestedOwner === 'all') return { owner: null, all: true };
  if (!requestedOwner || requestedOwner === 'macsomenos')
    return { owner: null, all: false };
  if (
    !/^[1-9]\d*$/.test(requestedOwner) ||
    !Number.isSafeInteger(Number(requestedOwner))
  ) {
    throw new BadRequestException('Vendedor inválido');
  }
  return { owner: Number(requestedOwner), all: false };
}
