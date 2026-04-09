import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('cart_items')
export class CartItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  cart_id!: string;

  @Column({ type: 'uuid' })
  product_id!: string;

  @Column({ type: 'int', default: 1 })
  qty!: number;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  offer_price!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
