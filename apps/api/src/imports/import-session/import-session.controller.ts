import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type {
  ImportSessionCandidateV1,
  ImportSessionChallengeResponseV1,
  ImportSessionConfirmResponseV1,
  ImportSessionListV1,
  ImportSessionObservationViewV1,
  ImportSessionPageV1,
  ImportSessionReceiptV1,
  ImportSessionResultV1,
  ImportSessionTerminalOutcomesV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";
import { ImportSessionErrorCode } from "@reformaflow/domain";
import { ServiceOwnedProjectAccess } from "../../common/decorators/service-owned-project-access.decorator";
import { ImportAuth, ImportAuthGuard } from "./import-session.auth";
import {
  IMPORT_SESSION_CAPABILITY,
  type ImportSessionCapability,
} from "./import-session.capability";
import type { AuthenticatedImportContext } from "./import-session.contract";
import { assertImportSessionOperationAvailable } from "./import-session.disabled";
import {
  ImportSessionError,
  ImportSessionExceptionFilter,
} from "./import-session.errors";
import {
  assertSessionId,
  ImportSessionService,
  parseCreateRequest,
  parseRevisionRequest,
} from "./import-session.service";
import { ImportUiGrantIssuer } from "./import-session-ui-grant";
import { ImportUiGuard } from "./import-session-ui.guard";
import {
  focusedDraftAnswerScope,
  isFocusedDraftAnswerRequest,
  parseFocusedDraftAnswerRequest,
} from "./import-session.focused-draft-answer";
import {
  documentaryAnswerScope,
  parseDocumentaryAnswerRequest,
} from "./import-session.native-answer";
import {
  ImportSessionWorkflowService,
  parseChallengeRequest,
  parseConfirmRequest,
  parseExecuteRequest,
} from "./import-session-workflow.service";

/**
 * Thin boundary: authenticate (verified JWT claims), UI-protect mutations, mint the runtime
 * grant, delegate. No business rule lives here. Each handler opts out of the global
 * ProjectAccessGuard's id extraction (`@ServiceOwnedProjectAccess()`); the service reauthorises
 * and resolves anchor/card ACL on every path. A NEW handler must decide that explicitly:
 * absence of the mark does not protect an id-less route. Broad writes remain OFF; services
 * independently qualify CSV without granting ordinary chat financial authority.
 */
@Controller("import-sessions")
@UseFilters(ImportSessionExceptionFilter)
@UseGuards(ImportAuthGuard)
export class ImportSessionController {
  constructor(
    private readonly service: ImportSessionService,
    private readonly issuer: ImportUiGrantIssuer,
    @Inject(IMPORT_SESSION_CAPABILITY)
    private readonly capability: ImportSessionCapability,
    private readonly workflow: ImportSessionWorkflowService,
  ) {}

  @Post()
  @ServiceOwnedProjectAccess()
  @UseGuards(ImportUiGuard)
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Body() body: unknown,
  ): Promise<ImportSessionViewV1> {
    // Kill switch first: a disabled create never reaches validation or the database.
    this.service.assertCreateAvailable();
    // INT-2: the guard only attested Origin + header. The grant is minted from the VALIDATED
    // request (strict parse, exact keys), never from the raw body.
    const validated = parseCreateRequest(body);
    const grant = this.issuer.issue(request, auth, {
      operation: "CREATE_SESSION",
      cardId: validated.cardId,
      createRequestId: validated.createRequestId,
      consentPolicyVersion: validated.consentPolicyVersion,
    });
    const { view, created } = await this.service.create(auth, body, grant);
    response.status(created ? 201 : 200);
    return view;
  }

  /** Recovery list: authenticated read, no UI header, not switched off by the writes switch. */
  @Get()
  @ServiceOwnedProjectAccess()
  list(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Query() query: unknown,
  ): Promise<ImportSessionListV1> {
    return this.service.list(auth, query);
  }

  @Get(":id/terminal-outcomes-v1")
  @ServiceOwnedProjectAccess()
  getTerminalOutcomesV1(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
  ): Promise<ImportSessionTerminalOutcomesV1> {
    return this.service.getTerminalOutcomesV1(auth, id);
  }

  @Get(":id")
  @ServiceOwnedProjectAccess()
  getSession(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Query() query: unknown,
  ): Promise<ImportSessionViewV1> {
    return this.service.getSession(auth, id, query);
  }

  @Get(":id/result")
  @ServiceOwnedProjectAccess()
  getResult(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
  ): Promise<ImportSessionResultV1> {
    return this.service.getResult(auth, id);
  }

  @Post(":id/cancel")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  cancel(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportSessionViewV1> {
    assertSessionId(id);
    const validated = parseRevisionRequest(body);
    const grant = this.issuer.issue(request, auth, {
      operation: "CANCEL_SESSION",
      sessionId: id,
      expectedRevision: validated.expectedRevision,
    });
    return this.service.cancel(auth, id, body, grant);
  }

  @Patch(":id/draft")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  edit(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request?: Request,
  ): Promise<ImportSessionViewV1> {
    if (isFocusedDraftAnswerRequest(body)) {
      assertSessionId(id);
      const validated = parseFocusedDraftAnswerRequest(body);
      if (!request)
        throw new ImportSessionError(ImportSessionErrorCode.UI_ACTION_REQUIRED);
      const grant = this.issuer.issue(
        request,
        auth,
        focusedDraftAnswerScope(id, validated),
      );
      return this.workflow.focusedDraftAnswer(auth, id, validated, grant);
    }
    return this.workflow.edit(auth, id, body);
  }

  @Post(":id/documentary-answer")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  documentaryAnswer(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportSessionViewV1> {
    assertSessionId(id);
    const validated = parseDocumentaryAnswerRequest(body);
    const grant = this.issuer.issue(
      request,
      auth,
      documentaryAnswerScope(id, validated),
    );
    return this.workflow.documentaryAnswer(auth, id, validated, grant);
  }

  @Post(":id/prepare")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  prepare(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportSessionViewV1> {
    return this.workflow.prepare(auth, id, body);
  }

  @Get(":id/observations")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  getObservations(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Query() query: unknown,
  ): Promise<ImportSessionPageV1<ImportSessionObservationViewV1>> {
    return this.service.getObservations(auth, id, query);
  }

  @Get(":id/candidates")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  getCandidates(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Query() query: unknown,
  ): Promise<ImportSessionPageV1<ImportSessionCandidateV1>> {
    return this.service.getCandidates(auth, id, query);
  }

  @Post(":id/confirmation-challenge")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  challenge(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportSessionChallengeResponseV1> {
    assertSessionId(id);
    const validated = parseChallengeRequest(body);
    const grant = this.issuer.issueFinancialAction(request, auth, {
      operation: "CHALLENGE",
      sessionId: id,
      expectedRevision: validated.expectedRevision,
      proposalHash: validated.proposalHash,
    });
    return this.workflow.challenge(auth, id, validated, grant);
  }

  @Post(":id/confirm")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  confirm(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportSessionConfirmResponseV1> {
    assertSessionId(id);
    const validated = parseConfirmRequest(body);
    const grant = this.issuer.issueFinancialAction(request, auth, {
      operation: "CONFIRM",
      sessionId: id,
      expectedRevision: validated.expectedRevision,
      proposalHash: validated.proposalHash,
      financialRequestId: validated.financialRequestId,
    });
    return this.workflow.confirm(auth, id, validated, grant);
  }

  @Post(":id/execute")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  execute(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportSessionReceiptV1> {
    assertSessionId(id);
    const validated = parseExecuteRequest(body);
    const grant = this.issuer.issueFinancialAction(request, auth, {
      operation: "EXECUTE",
      sessionId: id,
      financialRequestId: validated.financialRequestId,
    });
    return this.workflow.execute(auth, id, validated, grant);
  }
}
