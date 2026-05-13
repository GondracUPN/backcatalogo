import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type ProductStatus = 'draft' | 'listed' | 'sold' | 'hidden';
export type SaleType = 'PREVENTA' | 'VENTA_SIMPLE' | 'PROMOCION' | 'OFERTA';
export type IphoneModel = 'Normal' | 'Plus' | 'Pro' | 'Pro Max' | 'Mini' | 'E';
export type ProductCondition = 'Nuevo' | 'Usado' | 'Open Box' | 'Arreglado';
export type IncludesKind = 'Caja + Cubo + Cable' | 'Cubo + Cable' | 'Solo Cable' | 'Caja + Cable' | 'Caja sola' | 'Cable solo' | 'Ninguno' | 'Otros';
export type KeyboardLayout = 'Ingles' | 'Espanol' | 'Otro';

@Entity('products')
export class CatalogProduct {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  sku!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  price!: string;

  @Column({ type: 'text', nullable: true })
  iphone_model!: IphoneModel | null;

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
  includes!: IncludesKind | null;

  @Column({ type: 'text', nullable: true })
  includes_extra!: string | null;

  @Column({ type: 'text', nullable: true })
  keyboard_layout!: KeyboardLayout | null;

  @Column({ type: 'text', nullable: true })
  variant_group!: string | null;

  @Column({ type: 'text', nullable: true })
  sale_type!: SaleType | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  discount!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  final_price!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  min_offer_price!: string | null;

  @Column({ type: 'uuid', nullable: true })
  cart_id!: string | null;

  @Column({ type: 'text', default: 'draft' })
  status!: ProductStatus;

  @Column({ type: 'text', nullable: true })
  product_condition!: ProductCondition | null;

  @Column({ type: 'int', default: 0 })
  stock!: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
