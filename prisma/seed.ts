/**
 * Seed script — popula o banco SQLite com dados iniciais para desenvolvimento
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const defaultRooms = [
  'Sala de TV',
  'Sala de Estar',
  'Escritório',
  'Cozinha',
  'Quarto Casal',
  'Quarto Solteiro/Hóspedes',
  'Banheiro Social',
  'Banheiro Suíte',
  'Lavabo',
  'Área de Serviço',
  'Área Externa/Quintal',
  'Garagem',
  'Hall/Corredor',
  'Geral (casa toda)',
];

async function main() {
  console.log('🌱 Iniciando seed...');

  // 1. Tenant
  const tenant = await prisma.tenant.upsert({
    where: { id: 'dev-tenant-1' },
    update: {},
    create: { id: 'dev-tenant-1', name: 'Tenant Desenvolvimento' },
  });

  // 2. User
  await prisma.user.upsert({
    where: { id: 'dev-user-1' },
    update: {},
    create: {
      id: 'dev-user-1',
      tenantId: tenant.id,
      email: 'dev@reformaflow.com',
      name: 'Gabriel Barbosa',
      role: 'OWNER',
    },
  });

  // 3. Project
  const project = await prisma.project.upsert({
    where: { id: 'dev-project-1' },
    update: {},
    create: {
      id: 'dev-project-1',
      tenantId: tenant.id,
      name: 'Reforma Casa - Exemplo',
      description: 'Projeto de exemplo para desenvolvimento',
      startDate: new Date('2026-05-01'),
      endDate: new Date('2026-10-30'),
    },
  });

  // 4. Rooms
  for (let i = 0; i < defaultRooms.length; i++) {
    await prisma.room.upsert({
      where: { projectId_name: { projectId: project.id, name: defaultRooms[i]! } },
      update: {},
      create: { projectId: project.id, name: defaultRooms[i]!, order: i },
    });
  }

  // 5. Receipts
  const receipt1 = await prisma.receipt.create({
    data: {
      projectId: project.id,
      tenantId: tenant.id,
      valor: 10000000, // R$ 100.000,00
      data: new Date('2026-04-15'),
      tipo: 'ORCAMENTO_INICIAL',
      status: 'EM_CAIXA',
    },
  });

  const receipt2 = await prisma.receipt.create({
    data: {
      projectId: project.id,
      tenantId: tenant.id,
      valor: 2500000, // R$ 25.000,00
      data: new Date('2026-06-01'),
      tipo: 'PAGAMENTO',
      status: 'PREVISTO',
    },
  });

  // Cash flow for receipts
  for (const r of [receipt1, receipt2]) {
    await prisma.cashFlowEntry.create({
      data: {
        projectId: r.projectId,
        tenantId: r.tenantId,
        receiptId: r.id,
        valor: r.valor,
        tipo: 'RECEBIMENTO',
        data: r.data,
        categoria: r.tipo,
        status: r.status,
      },
    });
  }

  // 6. Expenses
  const cozinha = await prisma.room.findFirst({ where: { projectId: project.id, name: 'Cozinha' } });

  const expense1 = await prisma.expense.create({
    data: {
      projectId: project.id,
      tenantId: tenant.id,
      tipoDespesa: 'REVESTIMENTO',
      roomId: cozinha?.id,
      valor: 4500,
      quantidade: 50,
      valorTotal: 225000,
      fornecedor: 'Leroy Merlin',
      formaPagamento: 'A_VISTA',
      dataPagamento: new Date('2026-05-10'),
      status: 'PAGO',
    },
  });

  await prisma.cashFlowEntry.create({
    data: {
      projectId: project.id,
      tenantId: tenant.id,
      expenseId: expense1.id,
      valor: 225000,
      tipo: 'DESPESA',
      data: new Date('2026-05-10'),
      categoria: 'Revestimento',
      ambiente: 'Cozinha',
      formaPagamento: 'A_VISTA',
      status: 'PAGO',
    },
  });

  const expense2 = await prisma.expense.create({
    data: {
      projectId: project.id,
      tenantId: tenant.id,
      tipoDespesa: 'MAO_DE_OBRA',
      categoriaMaoDeObra: 'EMPREITEIRO',
      valor: 1500000,
      quantidade: 1,
      valorTotal: 1500000,
      fornecedor: 'João Pedreiro',
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 3,
      dataInicioParcela: new Date('2026-05-15'),
      status: 'PLANEJADO',
    },
  });

  const parcelBase = Math.floor(1500000 / 3);
  const remainder = 1500000 - parcelBase * 3;
  for (let i = 0; i < 3; i++) {
    const d = new Date('2026-05-15');
    d.setMonth(d.getMonth() + i);
    await prisma.cashFlowEntry.create({
      data: {
        projectId: project.id,
        tenantId: tenant.id,
        expenseId: expense2.id,
        valor: i === 2 ? parcelBase + remainder : parcelBase,
        tipo: 'DESPESA',
        data: d,
        categoria: 'Mão de Obra',
        subcategoria: 'Empreiteiro',
        formaPagamento: 'PARCELADO',
        status: 'PLANEJADO',
        parcela: `${i + 1}/3`,
      },
    });
  }

  console.log('🎉 Seed concluído!');
}

main()
  .catch((e) => { console.error('❌ Erro:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
