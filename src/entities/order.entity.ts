import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  product_id!: string;

  @Column({ type: 'int' })
  qty!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}

