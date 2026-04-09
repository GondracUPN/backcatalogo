import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('staged_products')
export class StagedProduct {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true })
  source_id!: string;

  @Column({ type: 'text' })
  sku!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  price!: string;

  @Column({ type: 'text', nullable: true })
  iphone_model!: string | null;

  @Column({ type: 'int', nullable: true })
  iphone_number!: number | null;

  @Column({ type: 'int', nullable: true })
  storage_gb!: number | null;

  @Column({ type: 'int', nullable: true })
  battery_cycles!: number | null;

  @Column({ type: 'int', nullable: true })
  battery_health!: number | null;

  @Column({ type: 'text', nullable: true })
  color!: string | null;

  @Column({ type: 'text', nullable: true })
  includes!: string | null;

  @Column({ type: 'text', nullable: true })
  includes_extra!: string | null;

  @Column({ type: 'text', nullable: true })
  keyboard_layout!: string | null;

  @Column({ type: 'text', nullable: true })
  sale_type!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  discount!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  final_price!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  min_offer_price!: string | null;

  @Column({ type: 'int', default: 0 })
  stock!: number;

  @Column({ type: 'text', default: 'draft' })
  status!: 'draft' | 'listed' | 'sold' | 'hidden';

  @Column({ type: 'text', nullable: true })
  product_condition!: string | null;

  @Column({ type: 'text', nullable: true })
  category!: string | null;

  @Column({ type: 'text', array: true, nullable: true })
  tags!: string[] | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  images!: any[];

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
