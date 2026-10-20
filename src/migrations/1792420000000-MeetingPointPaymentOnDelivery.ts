import { MigrationInterface, QueryRunner } from 'typeorm';

export class MeetingPointPaymentOnDelivery1792420000000 implements MigrationInterface {
  name = 'MeetingPointPaymentOnDelivery1792420000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE delivery_options
      SET conditions = 'Pago contraentrega: no pagas ningún adelanto. Pagas el equipo al recibirlo.', updated_at = now()
      WHERE code = 'punto_medio'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE delivery_options SET conditions = NULL, updated_at = now()
      WHERE code = 'punto_medio'
        AND conditions = 'Pago contraentrega: no pagas ningún adelanto. Pagas el equipo al recibirlo.'`);
  }
}
