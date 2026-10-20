// Estados de una solicitud de compra y transiciones permitidas.
// Ningún estado se alcanza sin una acción explícita del personal (o del flujo
// anterior del panel, registrado como tal en el historial).

export const REQUEST_STATUSES = [
  'nueva',
  'pendiente_confirmacion',
  'confirmada',
  'reservada',
  'pagada',
  'en_preparacion',
  'enviada',
  'entregada',
  'cancelada',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const STATUS_LABELS: Record<RequestStatus, string> = {
  nueva: 'Nueva',
  pendiente_confirmacion: 'Pendiente de confirmación',
  confirmada: 'Confirmada',
  reservada: 'Reservada',
  pagada: 'Pagada',
  en_preparacion: 'En preparación',
  enviada: 'Enviada',
  entregada: 'Entregada',
  cancelada: 'Cancelada',
};

export const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  nueva: ['pendiente_confirmacion', 'confirmada', 'cancelada'],
  pendiente_confirmacion: ['confirmada', 'cancelada'],
  confirmada: ['reservada', 'pagada', 'en_preparacion', 'cancelada'],
  reservada: ['confirmada', 'pagada', 'en_preparacion', 'cancelada'],
  pagada: ['en_preparacion', 'enviada', 'entregada', 'cancelada'],
  en_preparacion: ['enviada', 'entregada', 'cancelada'],
  enviada: ['entregada', 'cancelada'],
  entregada: [],
  cancelada: [],
};

export const TERMINAL: RequestStatus[] = ['entregada', 'cancelada'];
export const PAYMENT_METHODS = ['efectivo', 'transferencia', 'yape', 'plin', 'tarjeta', 'otro'] as const;

export function isStatus(value: unknown): value is RequestStatus {
  return (REQUEST_STATUSES as readonly string[]).includes(String(value));
}

export function canTransition(from: RequestStatus, to: RequestStatus) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Estados en los que la reserva de stock sigue vigente. */
export const HOLDS_STOCK: RequestStatus[] = ['reservada', 'pagada', 'en_preparacion', 'enviada'];
