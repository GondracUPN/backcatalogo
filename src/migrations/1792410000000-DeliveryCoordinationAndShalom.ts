import { MigrationInterface, QueryRunner } from 'typeorm';

export class DeliveryCoordinationAndShalom1792410000000 implements MigrationInterface {
  name = 'DeliveryCoordinationAndShalom1792410000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE delivery_options
      SET cost = 0, cost_note = 'Por calcular',
          description = 'Indica tu distrito. Coordinaremos el punto de encuentro y el costo por WhatsApp.',
          requires_district = true, requires_point = false, updated_at = now()
      WHERE code = 'punto_medio'`);
    await queryRunner.query(`INSERT INTO delivery_options
      (code, name, kind, description, cost, cost_note, conditions, requires_district, sort_order)
      VALUES ('shalom', 'Envío por Shalom', 'province',
        'Indica tu ciudad y distrito. Coordinaremos la agencia de destino y el costo por WhatsApp.',
        0, 'Por calcular', 'El envío por Shalom se realiza previo pago total del equipo.', true, 20)
      ON CONFLICT (code) DO NOTHING`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE delivery_options SET cost_note = NULL,
      description = 'Coordinamos un punto de encuentro en tu distrito.', updated_at = now()
      WHERE code = 'punto_medio'`);
    // Conserva la opción y sus referencias en solicitudes ya registradas.
    await queryRunner.query(`UPDATE delivery_options SET active = false, updated_at = now() WHERE code = 'shalom'`);
  }
}
