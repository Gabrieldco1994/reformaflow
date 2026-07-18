import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';

@Controller('feedback')
@UseInterceptors(TenantInterceptor)
@UseGuards(RolesGuard)
export class FeedbackController {
  constructor(private prisma: PrismaService) {}

  @Post()
  @Roles('USER', 'ADMIN')
  async submit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { id: string; username: string },
    @Body('message') message: string,
  ) {
    if (!message?.trim()) return { ok: false };
    await this.prisma.feedback.create({
      data: { tenantId, userId: user.id, username: user.username, message: message.trim() },
    });
    return { ok: true };
  }

  @Get()
  @Roles('ADMIN')
  list(@CurrentTenant() _tenantId: string) {
    // ponytail: admin sees all tenants — same pattern as GET /users?scope=all
    return this.prisma.feedback.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
}
