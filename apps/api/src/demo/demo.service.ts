import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectService } from '../project/project.service';
import { ReceiptService } from '../receipt/receipt.service';
import { ExpenseService } from '../expense/expense.service';

const DEMO_SEED_VERSION = 1;

@Injectable()
export class DemoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectService,
    private readonly receipts: ReceiptService,
    private readonly expenses: ExpenseService,
  ) {}

  async seedTenant(tenantId: string) {
    if (process.env['APP_MODE'] !== 'demo') {
      throw new NotFoundException();
    }

    const existing = await this.prisma.demoSeed.findFirst({
      where: { tenantId, deletedAt: null },
    });
    if (existing?.status === 'RUNNING') {
      throw new ConflictException('Seed já está em execução para este tenant.');
    }
    if (existing?.status === 'DONE' && existing.version === DEMO_SEED_VERSION) {
      throw new ConflictException('Tenant demo já foi seedado nesta versão.');
    }

    const projectCount = await this.prisma.project.count({
      where: { tenantId, deletedAt: null },
    });
    if (projectCount > 0 && !existing) {
      throw new ConflictException(
        'Tenant já possui dados; seed demo não será aplicado.',
      );
    }

    const seedRow =
      existing ??
      (await this.prisma.demoSeed.create({
        data: { tenantId, version: DEMO_SEED_VERSION, status: 'RUNNING' },
      }));
    if (existing) {
      await this.prisma.demoSeed.update({
        where: { id: existing.id },
        data: {
          status: 'RUNNING',
          version: DEMO_SEED_VERSION,
          errorMessage: null,
        },
      });
    }

    try {
      const pessoal = await this.projects.create(tenantId, {
        type: 'PESSOAL',
        name: 'Pessoal (Demo)',
        description: 'Projeto pessoal seedado para demonstração',
      });
      const reforma = await this.projects.create(tenantId, {
        type: 'REFORMA',
        name: 'Reforma (Demo)',
        description: 'Projeto de reforma seedado para demonstração',
      });

      await this.receipts.create(tenantId, pessoal.id, {
        valor: 12000,
        data: '2026-07-01',
        tipo: 'PAGAMENTO',
        status: 'EM_CAIXA',
      });

      const alvoReforma = await this.expenses.create(tenantId, reforma.id, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 850,
        quantidade: 1,
        titulo: 'Piso cerâmico (demo)',
        fornecedor: 'Loja Demo',
        formaPagamento: 'A_VISTA',
        dataPagamento: '2026-07-10',
        dataCompra: '2026-07-10',
        status: 'PLANEJADO',
      });

      await this.expenses.create(tenantId, pessoal.id, {
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 850,
        quantidade: 1,
        titulo: 'Espelho: piso reforma',
        fornecedor: 'Loja Demo',
        formaPagamento: 'A_VISTA',
        dataPagamento: '2026-07-10',
        dataCompra: '2026-07-10',
        status: 'PAGO',
        linkedExpenseId: alvoReforma.id,
      });

      await this.prisma.demoSeed.update({
        where: { id: seedRow.id },
        data: {
          status: 'DONE',
          version: DEMO_SEED_VERSION,
          personalProjectId: pessoal.id,
          reformaProjectId: reforma.id,
          errorMessage: null,
        },
      });

      return {
        ok: true,
        version: DEMO_SEED_VERSION,
        projects: { pessoalId: pessoal.id, reformaId: reforma.id },
      };
    } catch (err) {
      await this.prisma.demoSeed.update({
        where: { id: seedRow.id },
        data: {
          status: 'FAILED',
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }
}
