import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Patch,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { LoginThrottleGuard } from './login-throttle.guard';
import { CurrentUser } from '../common/decorators/tenant.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterOwnerDto } from './dto/register-owner.dto';
import { RegisterGuestDto } from './dto/register-guest.dto';
import { ClaimGuestDto } from './dto/claim-guest.dto';
import { UpdateObjectivesDto } from './dto/update-objectives.dto';

const COOKIE_NAME = 'rf_token';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 dias
const IS_PROD = process.env['NODE_ENV'] === 'production';

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: (IS_PROD ? 'none' : 'lax') as 'none' | 'lax',
  secure: IS_PROD,
  maxAge: COOKIE_MAX_AGE,
  path: '/',
};

@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private prisma: PrismaService,
  ) {}

  @Public()
  @Get('config')
  config() {
    return this.auth.getPublicConfig();
  }

  @Get('onboarding')
  onboarding(@CurrentUser() user: { id: string }) {
    return this.auth.getOnboarding(user.id);
  }

  @Get('objectives')
  objectives(@CurrentUser() user: { id: string }) {
    return this.auth.getSelfObjectives(user.id);
  }

  @Patch('objectives')
  updateObjectives(
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateObjectivesDto,
  ) {
    return this.auth.updateSelfObjectives(user.id, dto.projectTypes);
  }

  @Public()
  @UseGuards(LoginThrottleGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = dto.username || dto.email;
    if (!input) throw new BadRequestException('Informe usuário ou e-mail');
    const user = await this.auth.validateUser(input, dto.password);
    const token = this.auth.issueToken(user);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
    return { user: this.auth.buildPublicUser(user), token };
  }

  @Public()
  @UseGuards(LoginThrottleGuard)
  @Post('register')
  @HttpCode(201)
  async register(
    @Body() dto: RegisterOwnerDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user } = await this.auth.registerOwner(dto);
    const token = this.auth.issueToken(user);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
    return { user: this.auth.buildPublicUser(user), token };
  }

  @Public()
  @UseGuards(LoginThrottleGuard)
  @Post('guest')
  @HttpCode(201)
  async registerGuest(
    @Body() dto: RegisterGuestDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user } = await this.auth.registerGuest(dto);
    const token = this.auth.issueToken(user);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
    return { user: this.auth.buildPublicUser(user), token };
  }

  @Post('claim')
  @HttpCode(200)
  async claimGuest(
    @CurrentUser() user: { id: string },
    @Body() dto: ClaimGuestDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user: claimedUser } = await this.auth.claimGuest(user.id, dto);
    const token = this.auth.issueToken(claimedUser);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
    return { user: this.auth.buildPublicUser(claimedUser), token };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @CurrentUser() user: { id: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.prisma.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
    });
    res.clearCookie(COOKIE_NAME, {
      path: '/',
      sameSite: COOKIE_OPTIONS.sameSite,
      secure: COOKIE_OPTIONS.secure,
    });
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() user: { id: string }) {
    const fresh = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!fresh) return null;
    return this.auth.buildPublicUser(fresh);
  }
}
