// Ejecuta una tarea de preparación (p. ej. CREATE TABLE IF NOT EXISTS) una sola
// vez por proceso. Si falla, se olvida el resultado para reintentar después.
// Evita lanzar DDL en cada petición: ALTER TABLE toma un lock exclusivo aunque
// la columna ya exista y bloquea lecturas concurrentes.
const pending = new Map<string, Promise<void>>();

export function runOnce(key: string, task: () => Promise<unknown>): Promise<void> {
  let current = pending.get(key);
  if (!current) {
    current = task()
      .then(() => undefined)
      .catch((error) => {
        pending.delete(key);
        throw error;
      });
    pending.set(key, current);
  }
  return current;
}

export function resetRunOnceForTests() {
  pending.clear();
}
