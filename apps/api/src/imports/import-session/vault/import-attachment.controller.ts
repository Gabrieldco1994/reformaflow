import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { pipeline } from "node:stream/promises";
import {
  ImportSessionErrorCode,
  type ImportSessionUploadResponseV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { ServiceOwnedProjectAccess } from "../../../common/decorators/service-owned-project-access.decorator";
import { ImportAuth, ImportAuthGuard } from "../import-session.auth";
import type { AuthenticatedImportContext } from "../import-session.contract";
import {
  ImportSessionError,
  ImportSessionExceptionFilter,
} from "../import-session.errors";
import { ImportUiGrantIssuer } from "../import-session-ui-grant";
import { ImportUiGuard } from "../import-session-ui.guard";
import {
  assertSessionId,
  parseRevisionRequest,
} from "../import-session.service";
import { ImportSessionExtractionService } from "../import-session.extraction.service";
import {
  ImportUploadService,
  parseReserveRequest,
} from "./import-upload.service";
import { ImportContentService } from "./import-content.service";
import { validateImportUploadFraming } from "./vault-framing";

function noQuery(query: unknown): void {
  if (
    typeof query !== "object" ||
    query === null ||
    Array.isArray(query) ||
    Object.keys(query).length !== 0
  )
    throw new ImportSessionError(ImportSessionErrorCode.INVALID_INPUT);
}

@Controller("import-sessions")
@UseFilters(ImportSessionExceptionFilter)
@UseGuards(ImportAuthGuard)
export class ImportAttachmentController {
  constructor(
    private readonly uploads: ImportUploadService,
    private readonly content: ImportContentService,
    private readonly issuer: ImportUiGrantIssuer,
    private readonly extraction: ImportSessionExtractionService,
  ) {}

  @Post(":id/attachments/:attachmentId/analyze")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  async analyze(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param("id") id: string,
    @Param("attachmentId") attachmentId: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ): Promise<ImportSessionViewV1> {
    this.extraction.assertAvailable();
    noQuery(query);
    assertSessionId(id);
    assertSessionId(attachmentId);
    const parsed = parseRevisionRequest(body);
    const grant = this.issuer.issue(request, auth, {
      operation: "ANALYZE_ATTACHMENT",
      sessionId: id,
      attachmentId,
      expectedRevision: parsed.expectedRevision,
    });
    const abort = new AbortController();
    const disconnected = () => {
      if (!response.writableFinished) abort.abort();
    };
    const abandoned = () => abort.abort();
    request.once("aborted", abandoned);
    response.once("close", disconnected);
    try {
      return await this.extraction.analyzeAttached(
        auth,
        id,
        attachmentId,
        parsed,
        grant,
        abort.signal,
      );
    } finally {
      request.off("aborted", abandoned);
      response.off("close", disconnected);
    }
  }

  @Post(":id/attachments")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  reserve(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Req() request: Request,
    @Param("id") id: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ): Promise<ImportSessionViewV1> {
    this.uploads.assertAvailable("RESERVE");
    noQuery(query);
    assertSessionId(id);
    const parsed = parseReserveRequest(body);
    const grant = this.issuer.issue(request, auth, {
      operation: "RESERVE_ATTACHMENTS",
      sessionId: id,
      expectedRevision: parsed.expectedRevision,
    });
    return this.uploads.reserve(auth, id, body, grant);
  }

  @Put(":id/attachments/:attachmentId/content")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  upload(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param("id") id: string,
    @Param("attachmentId") attachmentId: string,
    @Query() query: unknown,
  ): Promise<ImportSessionUploadResponseV1> {
    const framing = validateImportUploadFraming(request.headers);
    response.setHeader("Connection", "close");
    response.once("finish", () => request.socket.destroy());
    if (!framing.ok) throw new ImportSessionError(framing.code);
    this.uploads.assertAvailable("UPLOAD");
    noQuery(query);
    assertSessionId(id);
    assertSessionId(attachmentId);
    const grant = this.issuer.issue(request, auth, {
      operation: "UPLOAD_CONTENT",
      sessionId: id,
      attachmentId,
      uploadGeneration: 1,
    });
    return this.uploads.uploadWithOutcome(
      auth,
      id,
      attachmentId,
      Number(request.headers["content-length"]),
      request,
      grant,
    );
  }

  @Get(":id/attachments/:attachmentId/content")
  @ServiceOwnedProjectAccess()
  download(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Param("attachmentId") attachmentId: string,
    @Query() query: unknown,
    @Res() response: Response,
  ): Promise<void> {
    noQuery(query);
    return this.content.download(
      auth,
      id,
      attachmentId,
      async (source, metadata) => {
        const name = encodeURIComponent(metadata.fileName).replace(
          /['()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="download"; filename*=UTF-8''${name}`,
        );
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Cache-Control", "private, no-store");
        response.setHeader("Content-Length", metadata.verifiedBytes);
        await pipeline(source, response);
      },
    );
  }
}
