import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('catalog_public')
export class CatalogPublic {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true })
  product_id!: string;

  @Column({ type: 'text', unique: true })
  slug!: string;

  @Column({ type: 'int', default: 0 })
  sort_order!: number;

  @Column({ type: 'boolean', default: false })
  is_published!: boolean;

  @Column({ type: 'text', nullable: true })
  category!: string | null;

  @Column({ type: 'text', array: true, nullable: true })
  tags!: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  images!: any[] | null;

  @Column({ type: 'text', nullable: true })
  seo_title!: string | null;

  @Column({ type: 'text', nullable: true })
  seo_desc!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}

