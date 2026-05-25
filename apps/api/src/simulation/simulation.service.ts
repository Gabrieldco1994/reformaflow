import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ExpenseTypeLabels,
  LaborCategoryLabels,
  ReceiptTypeLabels,
  allocateEmpreiteiroExpenses,
} from '@reformaflow/domain';

@Injectable()
export class SimulationService {
  constructor(private readonly prisma: PrismaService) {}

  /* ───── Scenarios CRUD ───── */

  async listScenarios(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);
    return this.prisma.simulation.findMany({
      where: { projectId, tenantId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
  }

  async createScenario(tenantId: string, projectId: string, name: string) {
    await this.validateProject(tenantId, projectId);
    return this.prisma.simulation.create({
      data: { projectId, tenantId, name },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
  }

  async renameScenario(tenantId: string, projectId: string, scenarioId: string, name: string) {
    await this.validateScenario(tenantId, projectId, scenarioId);
    return this.prisma.simulation.update({
      where: { id: scenarioId },
      data: { name },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
  }

  async deleteScenario(tenantId: string, projectId: string, scenarioId: string) {
    await this.validateScenario(tenantId, projectId, scenarioId);
    // Cascade delete is handled by Prisma (onDelete: Cascade on SimulationValue)
    await this.prisma.simulation.delete({ where: { id: scenarioId } });
    return { ok: true };
  }

  async duplicateScenario(tenantId: string, projectId: string, scenarioId: string, newName?: string) {
    const source = await this.validateScenario(tenantId, projectId, scenarioId);
    const name = newName || `${source.name} (Cópia)`;

    const newSim = await this.prisma.simulation.create({
      data: { projectId, tenantId, name },
    });

    const sourceValues = await this.prisma.simulationValue.findMany({
      where: { simulationId: scenarioId, projectId, tenantId },
    });

    if (sourceValues.length > 0) {
      await this.prisma.simulationValue.createMany({
        data: sourceValues.map((v) => ({
          projectId,
          tenantId,
          simulationId: newSim.id,
          key: v.key,
          valor: v.valor,
        })),
      });
    }

    return { id: newSim.id, name: newSim.name, createdAt: newSim.createdAt, updatedAt: newSim.updatedAt };
  }

  /* ───── Main simulation data ───── */

  async getData(tenantId: string, projectId: string, scenarioId?: string) {
    await this.validateProject(tenantId, projectId);

    const [receipts, expenses, cashFlowEntries] = await Promise.all([
      this.prisma.receipt.findMany({
        where: { projectId, tenantId, deletedAt: null, linkedReceiptId: null },
      }),
      this.prisma.expense.findMany({
        where: { projectId, tenantId, deletedAt: null, settledByExpenseId: null },
        include: { room: true },
      }),
      this.prisma.cashFlowEntry.findMany({
        where: {
          projectId,
          tenantId,
          deletedAt: null,
          OR: [
            { expenseId: null },
            { expense: { deletedAt: null, linkedExpenseId: null } },
          ],
          AND: [
            {
              OR: [
                { receiptId: null },
                { receipt: { deletedAt: null, linkedReceiptId: null } },
              ],
            },
          ],
        },
        orderBy: { data: 'asc' },
      }),
    ]);

    // KPIs base
    const dinheiroDisponivel = receipts
      .filter((r) => r.status === 'EM_CAIXA')
      .reduce((sum, r) => sum + r.valor, 0);

    const previsaoRecebimentos = receipts
      .filter((r) => r.status === 'PREVISTO')
      .reduce((sum, r) => sum + r.valor, 0);

    const totalRecebimentos = dinheiroDisponivel + previsaoRecebimentos;
    const previsaoGastos = expenses.reduce((sum, e) => sum + e.valorTotal, 0);
    const previsaoSaldo = totalRecebimentos - previsaoGastos;

    // Recebimentos por tipo
    const receiptTypes = Array.from(new Set(receipts.map((r) => r.tipo))).sort();
    const recebimentosPorTipo = receiptTypes.map((tipo) => {
      const total = receipts
        .filter((r) => r.tipo === tipo)
        .reduce((sum, r) => sum + r.valor, 0);
      return { key: tipo, label: ReceiptTypeLabels[tipo as keyof typeof ReceiptTypeLabels] ?? tipo, total };
    });

    // Despesas consolidadas por ambiente → tipos → categorias
    const expenseTypes = [
      'MATERIAL_CONSTRUCAO', 'ELETRODOMESTICO', 'REVESTIMENTO', 'ILUMINACAO',
      'MARMORE', 'VIDRACARIA_SERRALHERIA', 'METAL_CERAMICA', 'MARCENARIA', 'MAO_DE_OBRA',
    ];
    const laborCategories = [
      'EMPREITEIRO', 'INSTALADOR_PISO', 'INSTALADOR_MARMORE', 'PINTOR',
      'ELETRICISTA', 'VIDRACEIRO', 'SERRALHEIRO', 'MARCENEIRO',
    ];

    const allRooms = await this.prisma.room.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
    });

    // Rateio de Mão de Obra Empreiteiro entre ambientes com valor > 0.
    const expensesAllocated = allocateEmpreiteiroExpenses(expenses);

    const roomGroups = new Map<string, { label: string; expenses: typeof expensesAllocated }>();
    for (const room of allRooms) {
      roomGroups.set(room.id, { label: room.name, expenses: [] });
    }
    for (const exp of expensesAllocated) {
      if (!exp.roomId) continue;
      if (!roomGroups.has(exp.roomId)) {
        roomGroups.set(exp.roomId, { label: exp.room?.name ?? exp.roomId, expenses: [] });
      }
      roomGroups.get(exp.roomId)!.expenses.push(exp);
    }

    const ambientes = Array.from(roomGroups.entries()).map(([roomKey, { label, expenses: roomExpenses }]) => {
      const totalAmbiente = roomExpenses.reduce((s, e) => s + e.valorTotal, 0);
      const tipos = expenseTypes.map((tipo) => {
        const tipoExpenses = roomExpenses.filter((e) => e.tipoDespesa === tipo);
        const totalTipo = tipoExpenses.reduce((s, e) => s + e.valorTotal, 0);
        let categorias: { key: string; label: string; total: number }[] | undefined;
        if (tipo === 'MAO_DE_OBRA') {
          categorias = laborCategories.map((cat) => {
            const total = tipoExpenses
              .filter((e) => e.categoriaMaoDeObra === cat)
              .reduce((s, e) => s + e.valorTotal, 0);
            return { key: cat, label: LaborCategoryLabels[cat as keyof typeof LaborCategoryLabels] ?? cat, total };
          }).sort((a, b) => b.total - a.total);
        }
        return {
          key: tipo,
          label: ExpenseTypeLabels[tipo as keyof typeof ExpenseTypeLabels] ?? tipo,
          total: totalTipo,
          categorias,
        };
      }).sort((a, b) => b.total - a.total);
      return { key: roomKey, label, total: totalAmbiente, tipos };
    }).sort((a, b) => b.total - a.total);

    const allRoomsList = allRooms.map((r) => ({ key: r.id, label: r.name }));
    const porTipo = expenseTypes.map((tipo) => {
      const tipoExpenses = expensesAllocated.filter((e) => e.tipoDespesa === tipo);
      const totalTipo = tipoExpenses.reduce((s, e) => s + e.valorTotal, 0);
      const pagoTipo = tipoExpenses
        .filter((e) => e.status === 'PAGO')
        .reduce((s, e) => s + e.valorTotal, 0);
      const planejadoTipo = totalTipo - pagoTipo;
      const ambientesNested = allRoomsList.map((room) => {
        const roomTipoExpenses = tipoExpenses.filter((e) => e.roomId === room.key);
        const total = roomTipoExpenses.reduce((s, e) => s + e.valorTotal, 0);
        let categorias: { key: string; label: string; total: number }[] | undefined;
        if (tipo === 'MAO_DE_OBRA') {
          categorias = laborCategories.map((cat) => {
            const catTotal = roomTipoExpenses
              .filter((e) => e.categoriaMaoDeObra === cat)
              .reduce((s, e) => s + e.valorTotal, 0);
            return { key: cat, label: LaborCategoryLabels[cat as keyof typeof LaborCategoryLabels] ?? cat, total: catTotal };
          }).sort((a, b) => b.total - a.total);
        }
        return { key: room.key, label: room.label, total, categorias };
      }).sort((a, b) => b.total - a.total);
      return {
        key: tipo,
        label: ExpenseTypeLabels[tipo as keyof typeof ExpenseTypeLabels] ?? tipo,
        total: totalTipo,
        pago: pagoTipo,
        planejado: planejadoTipo,
        ambientes: ambientesNested,
      };
    }).sort((a, b) => b.total - a.total);

    // Monthly projection
    const monthlyMap = new Map<string, { recebimentos: number; despesas: number }>();
    for (const entry of cashFlowEntries) {
      const monthKey = entry.data.toISOString().slice(0, 7);
      if (!monthlyMap.has(monthKey)) monthlyMap.set(monthKey, { recebimentos: 0, despesas: 0 });
      const m = monthlyMap.get(monthKey)!;
      if (entry.tipo === 'RECEBIMENTO') m.recebimentos += entry.valor;
      else m.despesas += entry.valor;
    }
    const sortedMonths = Array.from(monthlyMap.keys()).sort();
    if (sortedMonths.length > 0) {
      const lastMonth = sortedMonths[sortedMonths.length - 1];
      const [ly, lm] = lastMonth.split('-').map(Number);
      let endDate = new Date(ly, lm - 1 + 12, 1);
      const now = new Date();
      if (endDate < now) endDate = new Date(now.getFullYear(), now.getMonth() + 6, 1);
      const [fy, fm] = sortedMonths[0].split('-').map(Number);
      const current = new Date(fy, fm - 1, 1);
      while (current < endDate) {
        const key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyMap.has(key)) monthlyMap.set(key, { recebimentos: 0, despesas: 0 });
        current.setMonth(current.getMonth() + 1);
      }
    }
    const projecaoMensal = Array.from(monthlyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, recebimentos: data.recebimentos, despesas: data.despesas }));

    // Load saved simulation values for the specified scenario
    const savedSimValues: Record<string, string> = {};
    if (scenarioId) {
      const savedValues = await this.prisma.simulationValue.findMany({
        where: { projectId, tenantId, simulationId: scenarioId },
      });
      for (const sv of savedValues) savedSimValues[sv.key] = sv.valor;
    }

    return {
      kpis: { totalRecebimentos, previsaoGastos, previsaoSaldo },
      recebimentosPorTipo,
      ambientes,
      porTipo,
      projecaoMensal,
      savedValues: savedSimValues,
    };
  }

  /* ───── Compare two scenarios ───── */

  async compareScenarios(tenantId: string, projectId: string, scenarioIds: string[]) {
    await this.validateProject(tenantId, projectId);

    const results: Record<string, Record<string, string>> = {};
    for (const sid of scenarioIds) {
      const vals = await this.prisma.simulationValue.findMany({
        where: { projectId, tenantId, simulationId: sid },
      });
      results[sid] = {};
      for (const v of vals) results[sid][v.key] = v.valor;
    }
    return results;
  }

  /* ───── Save values for a scenario ───── */

  async saveValues(tenantId: string, projectId: string, scenarioId: string, values: Record<string, string>) {
    await this.validateProject(tenantId, projectId);
    await this.validateScenario(tenantId, projectId, scenarioId);

    // Build the list of (key, valor) to upsert. Empty strings are treated as deletes.
    const upserts: Array<{ key: string; valor: string }> = [];
    for (const [key, valor] of Object.entries(values)) {
      if (valor && valor.trim() !== '') {
        upserts.push({ key, valor });
      }
    }
    const keysToKeep = upserts.map((u) => u.key);

    // Atomic replace: delete stale keys + upsert new ones inside a single transaction
    // so concurrent saveValues calls (e.g. two tabs editing the same scenario) can't
    // interleave delete + upsert and corrupt state. SQLite serializes writes, so we
    // also run upserts sequentially to avoid contention.
    return this.prisma.$transaction(async (tx) => {
      await tx.simulationValue.deleteMany({
        where: {
          projectId,
          tenantId,
          simulationId: scenarioId,
          ...(keysToKeep.length > 0 ? { key: { notIn: keysToKeep } } : {}),
        },
      });

      for (const u of upserts) {
        await tx.simulationValue.upsert({
          where: { simulationId_projectId_tenantId_key: { simulationId: scenarioId, projectId, tenantId, key: u.key } },
          update: { valor: u.valor },
          create: { projectId, tenantId, simulationId: scenarioId, key: u.key, valor: u.valor },
        });
      }

      return { ok: true };
    });
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }

  private async validateScenario(tenantId: string, projectId: string, scenarioId: string) {
    const sim = await this.prisma.simulation.findFirst({
      where: { id: scenarioId, projectId, tenantId },
    });
    if (!sim) throw new NotFoundException('Cenário não encontrado');
    return sim;
  }
}
