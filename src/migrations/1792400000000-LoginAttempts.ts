import { MigrationInterface, QueryRunner } from 'typeorm';

export class LoginAttempts1792400000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner) {
    await queryRunner.query(`CREATE TABLE auth_login_attempts (
      key text PRIMARY KEY, attempts integer NOT NULL, expires_at timestamptz NOT NULL
    )`);
    await queryRunner.query(`CREATE INDEX idx_auth_login_attempts_expiry ON auth_login_attempts(expires_at)`);
  }
  async down(queryRunner: QueryRunner) {
    await queryRunner.query(`DROP TABLE auth_login_attempts`);
  }
}
