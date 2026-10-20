import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../modules/auth/auth.service';

export type StaffPayload = ReturnType<AuthService['verifyToken']>;

/** Valida el JWT del encabezado Authorization y exige uno de los roles indicados. */
export function requireRole(auth: AuthService, authHeader: string | undefined, roles: string[]): StaffPayload {
  const token = (authHeader || '').startsWith('Bearer ') ? (authHeader || '').substring(7) : '';
  if (!token) throw new UnauthorizedException();
  let payload: StaffPayload;
  try {
    payload = auth.verifyToken(token);
  } catch {
    throw new UnauthorizedException();
  }
  if (!roles.includes(String(payload.role || '').toUpperCase())) throw new ForbiddenException();
  return payload;
}

/** null = inventario/datos de Macsomenos; número = datos propios de un vendedor independiente. */
export function ownerUserIdForStaff(staff: StaffPayload): number | null {
  return String(staff?.role || '').toUpperCase() === 'VENDEDOR' && !staff?.canViewServiceInventory
    ? Number(staff.sub)
    : null;
}
