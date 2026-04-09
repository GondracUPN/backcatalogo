import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type Role = 'ADMIN' | 'VENDEDOR' | 'CLIENTE';

@Entity('User')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  username!: string;

  @Column()
  passwordHash!: string;

  @Column({ type: 'enum', enum: ['ADMIN', 'VENDEDOR', 'CLIENTE'], default: 'CLIENTE' })
  role!: Role;

  @CreateDateColumn()
  createdAt!: Date;
}

