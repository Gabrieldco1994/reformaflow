import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseInterceptors(TenantInterceptor)
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: { role?: string },
    @Query('scope') scope?: string,
  ) {
    const includeAllTenants = scope === 'all' && requester?.role === 'ADMIN';
    return this.users.list(tenantId, includeAllTenants);
  }

  @Post()
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: { id: string },
    @Body() dto: CreateUserDto,
  ) {
    return this.users.create(tenantId, dto, requester.id);
  }

  @Patch(':id')
  update(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(tenantId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: { id: string },
    @Param('id') id: string,
  ) {
    return this.users.remove(tenantId, id, requester.id);
  }
}
