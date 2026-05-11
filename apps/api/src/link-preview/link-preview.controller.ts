import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { LinkPreviewService } from './link-preview.service';

@Controller('link-preview')
export class LinkPreviewController {
  constructor(private readonly linkPreviewService: LinkPreviewService) {}

  @Get()
  async getPreview(@Query('url') url: string) {
    if (!url) throw new BadRequestException('url query param is required');

    try {
      new URL(url);
    } catch {
      throw new BadRequestException('Invalid URL');
    }

    return this.linkPreviewService.getPreview(url);
  }
}
