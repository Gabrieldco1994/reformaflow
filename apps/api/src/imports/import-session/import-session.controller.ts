import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
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
  ImportSessionViewV1,
  ImportCurrentLotV1,
  ContinueAnsweringCommandV1,
  ImportDocumentaryCommandReceiptV1,
  ImportInterpretationResultV1,
} from "@reformaflow/domain";
import { ServiceOwnedProjectAccess } from "../../common/decorators/service-owned-project-access.decorator";
import { ImportAuth, ImportAuthGuard } from "./import-session.auth";
import {
  IMPORT_SESSION_CAPABILITY,
  type ImportSessionCapability,
} from "./import-session.capability";
import type { AuthenticatedImportContext } from "./import-session.contract";
import { assertImportSessionIntakeAvailable } from "./import-session.intake-gate";
import { ImportSessionExceptionFilter } from "./import-session.errors";
import {
  assertSessionId,
  ImportSessionService,
  parseCreateRequest,
  parseRevisionRequest,
} from "./import-session.service";
import { ImportUiGrantIssuer } from "./import-session-ui-grant";
import { ImportUiGuard } from "./import-session-ui.guard";
import {
  ImportSessionWorkflowService,
  parseChallengeRequest,
  parseConfirmRequest,
  parseExecuteRequest,
} from "./import-session-workflow.service";
import {
  documentaryPayloadHash,
  parseDeclarationCommand,
  parseContinueAnsweringCommand,
  parseDeferCommand,
  parsePrepareCurrentLotCommand,
  parseReactivateCommand,
  parseResolutionCommand,
  parseInterpretationRequest,
} from "./import-session-documentary.commands";
import { ImportSessionInterpretationService } from "./import-session-interpretation.service";
import {
  IMPORT_SESSION_THROTTLED_OPERATION,
  ImportSessionOperationThrottleGuard,
  ThrottleImportSessionOperation,
} from "./import-session-operation-throttle.guard";
import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault/vault-state";

/**
 * Thin boundary: authenticate (verified JWT claims), UI-protect mutations, mint the runtime
 * grant, delegate. No business rule lives here. Each handler opts out of the global
 * ProjectAccessGuard's id extraction (`@ServiceOwnedProjectAccess()`); the service reauthorises
 * and resolves anchor/card ACL on every path. A NEW handler must decide that explicitly:
 * absence of the mark does not protect an id-less route. Upload and extraction use their
 * dedicated boundaries.
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
    @Inject(IMPORT_VAULT_GATE)
    private readonly vaultGate: ImportVaultGate,
    private readonly workflow: ImportSessionWorkflowService,
    private readonly interpretation: ImportSessionInterpretationService,
  ) {}

  @Post()
  @ServiceOwnedProjectAccess()
  @ThrottleImportSessionOperation(IMPORT_SESSION_THROTTLED_OPERATION.CREATE)
  @UseGuards(ImportUiGuard, ImportSessionOperationThrottleGuard)
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Body() body: unknown,
  ): Promise<ImportSessionViewV1> {
    // Intake gate first: an unavailable create never reaches validation or the database.
    await assertImportSessionIntakeAvailable(this.capability, this.vaultGate);
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

  @Get(":id")
  @ServiceOwnedProjectAccess()
  getSession(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
  ): Promise<ImportSessionViewV1> {
    return this.service.getPublicSession(auth, id);
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

  @Post(":id/declarations")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  declaration(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    assertSessionId(id);
    const command = parseDeclarationCommand(body);
    const payloadHash = documentaryPayloadHash(id, "DECLARE", command);
    const grant = this.issuer.issue(request, auth, {
      operation: "DECLARE",
      sessionId: id,
      expectedRevision: command.expectedRevision,
      requestId: command.requestId,
      questionId: command.questionId,
      payloadHash,
    });
    return this.workflow.declare(auth, id, command, grant);
  }

  @Post(":id/resolutions")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  resolution(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    assertSessionId(id);
    const command = parseResolutionCommand(body);
    const payloadHash = documentaryPayloadHash(id, "RESOLVE", command);
    const grant = this.issuer.issue(request, auth, {
      operation: "RESOLVE",
      sessionId: id,
      expectedRevision: command.expectedRevision,
      requestId: command.requestId,
      questionId: command.questionId,
      payloadHash,
    });
    return this.workflow.resolve(auth, id, command, grant);
  }

  @Post(":id/defer")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  defer(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    assertSessionId(id);
    const command = parseDeferCommand(body);
    const payloadHash = documentaryPayloadHash(id, "DEFER", command);
    const grant = this.issuer.issue(request, auth, {
      operation: "DEFER",
      sessionId: id,
      expectedRevision: command.expectedRevision,
      requestId: command.requestId,
      lineId: command.lineId,
      payloadHash,
    });
    return this.workflow.defer(auth, id, command, grant);
  }

  @Post(":id/reactivate")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  reactivate(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    assertSessionId(id);
    const command = parseReactivateCommand(body);
    const payloadHash = documentaryPayloadHash(id, "REACTIVATE", command);
    const grant = this.issuer.issue(request, auth, {
      operation: "REACTIVATE",
      sessionId: id,
      expectedRevision: command.expectedRevision,
      requestId: command.requestId,
      lineId: command.lineId,
      payloadHash,
    });
    return this.workflow.reactivate(auth, id, command, grant);
  }

  @Post(":id/current-lot/prepare")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  prepareCurrentLot(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    assertSessionId(id);
    const command = parsePrepareCurrentLotCommand(body);
    const payloadHash = documentaryPayloadHash(
      id,
      "PREPARE_CURRENT_LOT",
      command,
    );
    const grant = this.issuer.issue(request, auth, {
      operation: "PREPARE_CURRENT_LOT",
      sessionId: id,
      expectedRevision: command.expectedRevision,
      requestId: command.requestId,
      payloadHash,
    });
    return this.workflow.prepareCurrentLot(auth, id, command, grant);
  }

  @Post(":id/current-lot/continue")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  continueAnswering(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    assertSessionId(id);
    const command: ContinueAnsweringCommandV1 =
      parseContinueAnsweringCommand(body);
    const payloadHash = documentaryPayloadHash(
      id,
      "CONTINUE_ANSWERING",
      command,
    );
    const grant = this.issuer.issue(request, auth, {
      operation: "CONTINUE_ANSWERING",
      sessionId: id,
      expectedRevision: command.expectedRevision,
      requestId: command.requestId,
      payloadHash,
    });
    return this.workflow.continueAnswering(auth, id, command, grant);
  }

  @Get(":id/current-lot")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  currentLot(
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
  ): Promise<ImportCurrentLotV1> {
    return this.workflow.currentLot(auth, id);
  }

  @Post(":id/interpretations")
  @ServiceOwnedProjectAccess()
  @HttpCode(200)
  @UseGuards(ImportUiGuard)
  interpret(
    @Req() request: Request,
    @ImportAuth() auth: AuthenticatedImportContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ImportInterpretationResultV1> {
    assertSessionId(id);
    const command = parseInterpretationRequest(body);
    const payloadHash = documentaryPayloadHash(
      id,
      "INTERPRET_QUESTION",
      command,
    );
    const grant = this.issuer.issue(request, auth, {
      operation: "INTERPRET_QUESTION",
      sessionId: id,
      expectedRevision: command.expectedRevision,
      requestId: command.requestId,
      questionId: command.questionId,
      payloadHash,
    });
    return this.interpretation.interpret(auth, id, command, grant);
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
      confirmationHash: validated.confirmationHash,
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
      confirmationHash: validated.confirmationHash,
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
