import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlantService } from '../plant/plant.service';
import { buildPlantDiagnosisPrompt } from './diagnosis-prompt';
import { buildPlantSchedule } from './plants-schedule';
import { parseJsonWithRepair } from '../common/json-repair';
import { normalizeDiagnosisCommonNamesFromJbrj } from './jbrj-reference';
import { PLANTS_AI_GENERATED_BY } from './plants-ai.constants';

/** Sinaliza HTTP 429 (cota diária/por minuto excedida) num modelo específico do Gemini. */
class GeminiQuotaExceededError extends Error {
  constructor(
    public readonly model: string,
    detail: string,
  ) {
    super('Cota do Gemini excedida para o modelo ' + model + ': ' + detail);
  }
}

type PlantHealthStatus = 'SAUDAVEL' | 'ATENCAO' | 'CRITICA';
type PlantPetRisk = 'SEGURO' | 'CAUTELA' | 'TOXICA';

type PersistedScheduleResult = {
  reminders: number;
  maintenance: number;
  diagnosisLog: boolean;
};

export interface PlantDiagnosisResult {
  especieProvavel: {
    nomePopular: string;
    nomeCientifico: string;
    confianca: number;
  };
  especiesAlternativas?: Array<{
    nomePopular: string;
    nomeCientifico: string;
    confianca: number;
  }>;
  saude: {
    status: PlantHealthStatus;
    confianca: number;
    sinais: string[];
  };
  pet: {
    risco: PlantPetRisk | 'DESCONHECIDO';
    observacao: string;
    fonteReferencia?: 'ASPCA' | 'desconhecido';
  };
  cuidados: {
    rega: string;
    luz: string;
    poda: string;
    adubacao: string;
    solo: string;
  };
  problemasPossiveis: Array<{
    nome: string;
    gravidade: 'BAIXA' | 'MEDIA' | 'ALTA';
    probabilidade: number;
    descricao: string;
    planoAcao: string[];
  }>;
  qualidadeImagem?: {
    status: 'BOA' | 'LIMITADA' | 'RUIM';
    motivos: string[];
    recomendarNovaFoto: boolean;
  };
}

@Injectable()
export class PlantsAiService {
  private readonly apiKey = process.env['GEMINI_API_KEY'];
  private readonly model = process.env['PLANTS_AI_MODEL'] ?? 'gemini-2.5-flash';
  // Usado quando o modelo principal estoura a cota diária (HTTP 429).
  private readonly fallbackModel = process.env['PLANTS_AI_FALLBACK_MODEL'] ?? 'gemini-2.5-flash-lite';

  constructor(
    private readonly prisma: PrismaService,
    private readonly plantService: PlantService,
  ) {}

  private buildGeneratedScheduleFilter(tenantId: string, projectId: string, plantId?: string) {
    return {
      tenantId,
      projectId,
      plantId: plantId ?? null,
      generatedBy: PLANTS_AI_GENERATED_BY,
      deletedAt: null,
    };
  }

  async diagnose(
    tenantId: string,
    projectId: string,
    file: Express.Multer.File | undefined,
  ): Promise<PlantDiagnosisResult> {
    if (!file || !file.buffer?.length) {
      throw new BadRequestException('Arquivo de imagem é obrigatório');
    }
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('Envie um arquivo de imagem válido');
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
      select: { id: true, type: true },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    if (project.type !== 'PLANTAS') {
      throw new BadRequestException('Diagnóstico IA disponível apenas para projetos PLANTAS');
    }
    if (!this.apiKey) {
      throw new ServiceUnavailableException('GEMINI_API_KEY não configurada');
    }

    const prompt = buildPlantDiagnosisPrompt();

    // Tenta primeiro no modelo principal; se a cota diária estourar (429),
    // cai automaticamente para o modelo de fallback (mais leve, cota separada).
    let rawText: string | undefined;
    try {
      rawText = await this.callGemini(this.model, prompt, file);
    } catch (err) {
      if (err instanceof GeminiQuotaExceededError && this.fallbackModel && this.fallbackModel !== this.model) {
        rawText = await this.callGemini(this.fallbackModel, prompt, file);
      } else {
        throw err;
      }
    }

    if (!rawText) {
      throw new ServiceUnavailableException('Gemini retornou resposta vazia');
    }

    let diagnosis: PlantDiagnosisResult;
    try {
      diagnosis = parseJsonWithRepair<PlantDiagnosisResult>(rawText);
    } catch {
      throw new ServiceUnavailableException(
        'Gemini retornou um resultado que não pôde ser interpretado. Tente novamente com outra foto.',
      );
    }

    return normalizeDiagnosisCommonNamesFromJbrj(diagnosis);
  }

  /** Chama a API do Gemini com o modelo informado; lança GeminiQuotaExceededError em 429. */
  private async callGemini(
    model: string,
    prompt: string,
    file: Express.Multer.File,
  ): Promise<string | undefined> {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + this.apiKey;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: file.mimetype,
                  data: file.buffer.toString('base64'),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 16384,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(90000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 429) {
        throw new GeminiQuotaExceededError(model, errorText.slice(0, 200));
      }
      throw new ServiceUnavailableException(
        'Falha ao consultar Gemini (' + response.status + '): ' + errorText.slice(0, 200),
      );
    }

    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return payload.candidates?.[0]?.content?.parts?.[0]?.text;
  }

  async diagnoseAndSchedule(
    tenantId: string,
    projectId: string,
    file: Express.Multer.File | undefined,
    persist = true,
    plantId?: string,
    nome?: string,
  ) {
    if (plantId) {
      const plant = await this.prisma.plant.findFirst({ where: { id: plantId, tenantId, projectId } });
      if (!plant) throw new NotFoundException('Planta não encontrada');
    }

    const diagnosis = await this.diagnose(tenantId, projectId, file);

    // Sem plantId: este é o fluxo de "criar planta nova a partir do diagnóstico".
    // Cria a planta agora (só depois do diagnóstico ter funcionado, pra não deixar
    // registro órfão se o Gemini falhar) usando o nome dado pelo usuário ou, na
    // falta dele, o nome popular que a IA identificou.
    if (!plantId && persist) {
      const created = await this.plantService.create(tenantId, projectId, {
        nome: nome?.trim() || diagnosis.especieProvavel?.nomePopular || 'Nova planta',
      });
      plantId = created.id;
    }

    const plan = buildPlantSchedule(diagnosis, plantId);
    let persisted: PersistedScheduleResult = { reminders: 0, maintenance: 0, diagnosisLog: false };

    if (persist) {
      const generatedScheduleFilter = this.buildGeneratedScheduleFilter(tenantId, projectId, plantId);
      persisted = await this.prisma.$transaction(async (tx) => {
        const deletedAt = new Date();

        // The transaction callback bypasses Prisma soft-delete middleware, so we must soft-delete manually.
        await tx.reminder.updateMany({
          where: generatedScheduleFilter,
          data: { deletedAt },
        });
        await tx.maintenanceLog.updateMany({
          where: generatedScheduleFilter,
          data: { deletedAt },
        });

        const reminderResult = plan.reminders.length
          ? await tx.reminder.createMany({
              data: plan.reminders.map((reminder) => ({
                tenantId,
                projectId,
                plantId: reminder.plantId ?? null,
                titulo: reminder.titulo,
                descricao: reminder.descricao,
                data: reminder.data,
                recorrencia: reminder.recorrencia,
                status: 'PENDENTE',
                prioridade: reminder.prioridade,
                generatedBy: PLANTS_AI_GENERATED_BY,
              })),
            })
          : { count: 0 };
        const maintenanceResult = plan.maintenance.length
          ? await tx.maintenanceLog.createMany({
              data: plan.maintenance.map((maintenance) => ({
                tenantId,
                projectId,
                plantId: maintenance.plantId ?? null,
                tipo: maintenance.tipo,
                dataRealizada: maintenance.dataRealizada,
                dataProxima: maintenance.dataProxima,
                observacoes: maintenance.observacoes,
                generatedBy: PLANTS_AI_GENERATED_BY,
              })),
            })
          : { count: 0 };

        if (!plantId) {
          return {
            reminders: reminderResult.count,
            maintenance: maintenanceResult.count,
            diagnosisLog: false,
          };
        }

        await tx.plantDiagnosisLog.create({
          data: {
            plantId,
            projectId,
            tenantId,
            especiePopular: diagnosis.especieProvavel?.nomePopular,
            especieCientifica: diagnosis.especieProvavel?.nomeCientifico,
            confiancaEspecie: diagnosis.especieProvavel?.confianca,
            saudeStatus: diagnosis.saude?.status,
            saudeConfianca: diagnosis.saude?.confianca,
            riscoPet: diagnosis.pet?.risco,
            diagnosisJson: JSON.stringify(diagnosis),
          },
        });
        await tx.plant.update({
          where: { id: plantId },
          data: {
            especiePopular: diagnosis.especieProvavel?.nomePopular,
            especieCientifica: diagnosis.especieProvavel?.nomeCientifico,
            ultimaSaude: diagnosis.saude?.status,
            ultimoRiscoPet: diagnosis.pet?.risco,
            ultimoDiagnosticoEm: new Date(),
          },
        });

        return {
          reminders: reminderResult.count,
          maintenance: maintenanceResult.count,
          diagnosisLog: true,
        };
      });

      // A foto usada no diagnóstico vira a foto de listagem da planta.
      if (plantId && file?.buffer) {
        await this.plantService
          .setPhoto(tenantId, projectId, plantId, file)
          .catch(() => undefined);
      }
    }

    return {
      diagnosis,
      plantId: plantId ?? null,
      schedule: {
        suggested: {
          reminders: plan.reminders.length,
          maintenance: plan.maintenance.length,
        },
        persisted,
      },
    };
  }

  async getPlantInsights(tenantId: string, projectId: string, plantId: string) {
    const plant = await this.prisma.plant.findFirst({
      where: { id: plantId, tenantId, projectId },
      select: { id: true },
    });
    if (!plant) throw new NotFoundException('Planta não encontrada');

    // ponytail: fetch latest diagnosis log (by createdAt DESC limit 1), not all logs
    const latestDiagnosis = await this.prisma.plantDiagnosisLog.findFirst({
      where: { plantId, tenantId, projectId },
      orderBy: { createdAt: 'desc' },
    });

    let diagnosis: PlantDiagnosisResult | null = null;
    let lastDiagnosisDate: Date | undefined;
    if (latestDiagnosis?.diagnosisJson) {
      try {
        diagnosis = JSON.parse(latestDiagnosis.diagnosisJson) as PlantDiagnosisResult;
        lastDiagnosisDate = latestDiagnosis.createdAt;
      } catch {
        // malformed JSON, skip
      }
    }

    const filter = { plantId, tenantId, projectId, deletedAt: null };
    const [reminders, maintenance] = await Promise.all([
      this.prisma.reminder.findMany({ where: filter, orderBy: { data: 'asc' } }),
      this.prisma.maintenanceLog.findMany({ where: filter, orderBy: { dataProxima: 'asc' } }),
    ]);

    return {
      diagnosis,
      cuidadoAgendado: {
        reminders: reminders.map((r) => ({
          titulo: r.titulo,
          data: r.data,
          status: r.status,
          prioridade: r.prioridade,
        })),
        maintenance: maintenance.map((m) => ({
          tipo: m.tipo,
          dataRealizada: m.dataRealizada,
          custo: m.custo ?? 0,
        })),
      },
      lastDiagnosisDate,
    };
  }
}
