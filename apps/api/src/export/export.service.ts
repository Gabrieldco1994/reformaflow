import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BudgetItemService } from '../budget-item/budget-item.service';
import {
  calculateReleasedAmount,
  calculateRollingBalance,
  CashFlowType,
} from '@reformaflow/domain';
import * as ExcelJS from 'exceljs';

/**
 * Gera planilha Excel compatível com a estrutura original
 * Controle_Reforma_Casa.xlsx (6 abas)
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budgetItemService: BudgetItemService,
  ) {}

  async generateExcel(tenantId: string, projectId: string): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ReformaFlow';

    await this.buildDashboardSheet(workbook, tenantId, projectId);
    await this.buildBudgetSheet(workbook, tenantId, projectId);
    await this.buildContractorSheet(workbook, projectId);
    await this.buildPurchasesSheet(workbook, projectId);
    await this.buildCashFlowSheet(workbook, projectId);
    await this.buildChangeOrdersSheet(workbook, projectId);

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private async buildDashboardSheet(wb: ExcelJS.Workbook, tenantId: string, projectId: string) {
    const ws = wb.addWorksheet('Dashboard');
    const summary = await this.budgetItemService.getDashboardSummary(tenantId, projectId);

    ws.getCell('A1').value = '🏠 Dashboard - Reforma Casa';
    ws.getCell('A1').font = { bold: true, size: 14 };

    ws.getCell('A3').value = 'Orçamento Previsto';
    ws.getCell('B3').value = summary.totalPlanned;
    ws.getCell('C3').value = 'Total Gasto';
    ws.getCell('D3').value = summary.totalActual;
    ws.getCell('E3').value = 'Saldo Disponível';
    ws.getCell('F3').value = summary.totalBalance;
    ws.getCell('G3').value = '% Consumido';
    ws.getCell('H3').value = summary.percentConsumed;
    ['B3', 'D3', 'F3'].forEach((c) => { ws.getCell(c).numFmt = '#,##0.00'; });
    ws.getCell('H3').numFmt = '0.0%';

    ws.getCell('A5').value = 'Ambiente';
    ws.getCell('B5').value = 'Previsto (R$)';
    ws.getCell('C5').value = 'Realizado (R$)';
    ws.getRow(5).font = { bold: true };

    summary.byRoom.forEach((room, i) => {
      const row = i + 6;
      ws.getCell(`A${row}`).value = room.roomName;
      ws.getCell(`B${row}`).value = room.planned;
      ws.getCell(`C${row}`).value = room.actual;
      ws.getCell(`B${row}`).numFmt = '#,##0.00';
      ws.getCell(`C${row}`).numFmt = '#,##0.00';
    });

    ws.columns = [{ width: 25 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 18 }, { width: 15 }, { width: 15 }, { width: 12 }];
  }

  private async buildBudgetSheet(wb: ExcelJS.Workbook, tenantId: string, projectId: string) {
    const ws = wb.addWorksheet('Orçamento Master');
    const items = await this.budgetItemService.findAllByProject(tenantId, projectId);

    ws.addRow(['Ambiente', 'Tipo de Obra', 'Previsto (R$)', 'Realizado (R$)', 'Saldo (R$)', '% Consumido', 'Status']);
    ws.getRow(1).font = { bold: true };

    items.forEach((item) => {
      const statusLabel = item.status === '-' ? '-' : item.status === 'OK' ? 'OK' : item.status === 'WARNING' ? 'Atenção' : 'Estourado';
      const row = ws.addRow([item.roomName, item.workTypeName, item.planned, item.actual, item.balance, item.percentConsumed, statusLabel]);
      row.getCell(3).numFmt = '#,##0.00';
      row.getCell(4).numFmt = '#,##0.00';
      row.getCell(5).numFmt = '#,##0.00';
      row.getCell(6).numFmt = '0.0%';
      if (item.status === 'OVER_BUDGET') row.getCell(7).font = { color: { argb: 'FFFF0000' }, bold: true };
      else if (item.status === 'WARNING') row.getCell(7).font = { color: { argb: 'FFFF8C00' } };
    });

    ws.columns = [{ width: 28 }, { width: 22 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 12 }];
  }

  private async buildContractorSheet(wb: ExcelJS.Workbook, projectId: string) {
    const ws = wb.addWorksheet('Empreiteiro');
    ws.addRow(['Etapa', 'Descrição', 'Valor Contratado (R$)', '% Concluído', 'Valor Liberado (R$)', 'Data Pagamento', 'Forma Pagamento', 'Status', 'Nota Fiscal', 'Observações']);
    ws.getRow(1).font = { bold: true };

    const contractors = await this.prisma.contractor.findMany({
      where: { projectId },
      include: { milestones: { orderBy: { percentage: 'asc' } } },
    });

    for (const c of contractors) {
      for (const m of c.milestones) {
        ws.addRow([
          m.stage, m.description, c.contractedAmount * m.percentage, m.percentCompleted,
          calculateReleasedAmount(c.contractedAmount, m.percentCompleted),
          m.paymentDate ? new Date(m.paymentDate).toLocaleDateString('pt-BR') : '',
          m.paymentMethod ?? 'PIX', m.paymentStatus === 'PAID' ? 'Pago' : 'Pendente',
          m.hasInvoice ? 'Sim' : 'Não', m.notes ?? '',
        ]);
      }
    }
    ws.columns = [{ width: 20 }, { width: 35 }, { width: 18 }, { width: 12 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 25 }];
  }

  private async buildPurchasesSheet(wb: ExcelJS.Workbook, projectId: string) {
    const ws = wb.addWorksheet('Compras Materiais');
    ws.addRow(['Data', 'Item', 'Ambiente', 'Tipo de Obra', 'Loja', 'Forma Pagamento', 'Valor Total (R$)', 'Parcelas', 'Valor Parcela (R$)', 'Garantia (meses)', 'Nota Fiscal', 'Observações']);
    ws.getRow(1).font = { bold: true };

    const purchases = await this.prisma.materialPurchase.findMany({
      where: { projectId }, include: { room: true, workType: true }, orderBy: { date: 'asc' },
    });

    for (const p of purchases) {
      ws.addRow([
        new Date(p.date).toLocaleDateString('pt-BR'), p.item, p.room.name, p.workType.name,
        p.store ?? '', p.paymentMethod, p.totalAmount, p.installments, p.installmentAmount,
        p.warrantyMonths ?? '', p.hasInvoice ? 'Sim' : 'Não', p.notes ?? '',
      ]);
    }
    const totalRow = ws.addRow(['TOTAL', '', '', '', '', '', purchases.reduce((s, p) => s + p.totalAmount, 0)]);
    totalRow.font = { bold: true };
    ws.columns = [{ width: 12 }, { width: 30 }, { width: 22 }, { width: 20 }, { width: 18 }, { width: 16 }, { width: 14 }, { width: 10 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 25 }];
  }

  private async buildCashFlowSheet(wb: ExcelJS.Workbook, projectId: string) {
    const ws = wb.addWorksheet('Fluxo de Caixa');
    ws.addRow(['Data Prevista', 'Data Efetiva', 'Descrição', 'Ambiente', 'Tipo de Obra', 'Tipo', 'Valor (R$)', 'Saldo Acumulado (R$)', 'Status']);
    ws.getRow(1).font = { bold: true };

    const entries = await this.prisma.cashFlowEntry.findMany({
      where: { projectId }, include: { room: true, workType: true }, orderBy: { plannedDate: 'asc' },
    });

    const balances = calculateRollingBalance(
      entries.map((e) => ({ type: e.type as CashFlowType, amount: e.amount })),
    );

    entries.forEach((e, i) => {
      ws.addRow([
        new Date(e.plannedDate).toLocaleDateString('pt-BR'),
        e.effectiveDate ? new Date(e.effectiveDate).toLocaleDateString('pt-BR') : '',
        e.description, e.room?.name ?? '', e.workType?.name ?? '',
        e.type === 'INCOME' ? 'Entrada' : 'Saída', e.amount, balances[i],
        e.status === 'EXECUTED' ? 'Realizado' : e.status === 'OVERDUE' ? 'Vencido' : 'Previsto',
      ]);
    });
    ws.columns = [{ width: 14 }, { width: 14 }, { width: 30 }, { width: 22 }, { width: 20 }, { width: 10 }, { width: 14 }, { width: 16 }, { width: 12 }];
  }

  private async buildChangeOrdersSheet(wb: ExcelJS.Workbook, projectId: string) {
    const ws = wb.addWorksheet('Pendências e Aditivos');
    ws.addRow(['Data', 'Item / Mudança', 'Motivo', 'Ambiente', 'Tipo de Obra', 'Valor Adicional (R$)', 'Aprovado Por', 'Status', 'Observações']);
    ws.getRow(1).font = { bold: true };

    const orders = await this.prisma.changeOrder.findMany({
      where: { projectId }, include: { room: true, workType: true }, orderBy: { date: 'desc' },
    });

    for (const o of orders) {
      ws.addRow([
        new Date(o.date).toLocaleDateString('pt-BR'), o.item, o.reason,
        o.room?.name ?? '', o.workType?.name ?? '', o.additionalAmount,
        o.approvedBy ?? '', o.status === 'APPROVED' ? 'Aprovado' : o.status === 'REJECTED' ? 'Rejeitado' : 'Pendente',
        o.notes ?? '',
      ]);
    }
    const approved = orders.filter((o) => o.status === 'APPROVED');
    const totalRow = ws.addRow(['TOTAL ADITIVOS', '', '', '', '', approved.reduce((s, o) => s + o.additionalAmount, 0)]);
    totalRow.font = { bold: true };
    ws.columns = [{ width: 12 }, { width: 30 }, { width: 30 }, { width: 22 }, { width: 20 }, { width: 16 }, { width: 14 }, { width: 12 }, { width: 25 }];
  }
}
