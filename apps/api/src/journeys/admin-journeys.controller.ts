import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateJourneyDto } from './dto/create-journey.dto';
import { UpdateJourneyDto } from './dto/update-journey.dto';
import { AdminJourneyView, JourneysAdminService } from './journeys-admin.service';

/**
 * Painel do admin: CRUD de Jornadas — GLOBAL, vale para todos os tenants
 * (mesmo escopo de `AdminOnboardingJourneyController`, que esta API
 * substitui — issue #339). Nenhuma rota física de `DELETE`: retirar uma
 * jornada de circulação é `PUT { active: false }`.
 */
@Controller('admin/journeys')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class AdminJourneysController {
  constructor(private readonly journeys: JourneysAdminService) {}

  @Get()
  list(): Promise<AdminJourneyView[]> {
    return this.journeys.list();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<AdminJourneyView> {
    return this.journeys.get(id);
  }

  @Post()
  create(@Body() dto: CreateJourneyDto): Promise<AdminJourneyView> {
    return this.journeys.create(dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateJourneyDto): Promise<AdminJourneyView> {
    return this.journeys.update(id, dto);
  }
}
