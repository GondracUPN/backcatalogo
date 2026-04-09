import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('catalog_views')
export class CatalogView {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  product_id!: string;

  @Column({ type: 'text' })
  product_slug!: string;

  @Column({ type: 'text', nullable: true })
  product_title!: string | null;

  @Column({ type: 'text', nullable: true })
  category!: string | null;

  @Column({ type: 'text' })
  session_id!: string;

  @Column({ type: 'text', nullable: true })
  path!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
