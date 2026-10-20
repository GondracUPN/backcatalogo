import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type ThemeMode = 'scheduled' | 'on' | 'off';

@Entity('site_themes')
export class SiteTheme {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', default: 'custom' })
  preset!: string;

  // scheduled: según fechas; on: forzada; off: desactivada.
  @Column({ type: 'text', default: 'scheduled' })
  mode!: ThemeMode;

  @Column({ type: 'timestamptz', nullable: true })
  starts_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  ends_at!: Date | null;

  // Se repite cada año en las mismas fechas (hora de Lima).
  @Column({ type: 'boolean', default: false })
  recurring_yearly!: boolean;

  @Column({ type: 'int', default: 0 })
  priority!: number;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  colors!: Record<string, string>;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  banner!: Record<string, unknown>;

  @Column({ type: 'text', default: 'none' })
  effect!: string;

  @Column({ type: 'text', nullable: true })
  updated_by!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
