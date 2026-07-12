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
  private readonly model = 'gemini-2.5-flash';

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

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + this.model + ':generateContent?key=' + this.apiKey;
    const prompt = buildPlantDiagnosisPrompt();

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
      throw new ServiceUnavailableException(
        'Falha ao consultar Gemini (' + response.status + '): ' + errorText.slice(0, 200),
      );
    }

    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
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

  async diagnoseAndSchedule(
    tenantId: string,
    projectId: string,
    file: Express.Multer.File | undefined,
    persist = true,
    plantId?: string,
  ) {
    if (plantId) {
      const plant = await this.prisma.plant.findFirst({ where: { id: plantId, tenantId, projectId } });
      if (!plant) throw new NotFoundException('Planta não encontrada');
    }

    const diagnosis = await this.diagnose(tenantId, projectId, file);
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
      schedule: {
        suggested: {
          reminders: plan.reminders.length,
          maintenance: plan.maintenance.length,
        },
        persisted,
      },
    };
  }
}
