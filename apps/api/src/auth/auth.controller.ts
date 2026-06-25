import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
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
  @UseGuards(LoginThrottleGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.validateUser(dto.username, dto.password);
    const token = this.auth.issueToken(user);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
    return { user: this.auth.buildPublicUser(user), token };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Res({ passthrough: true }) res: Response) {
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
