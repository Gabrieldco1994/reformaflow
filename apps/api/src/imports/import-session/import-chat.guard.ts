import {
  Injectable,
  HttpException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ImportSessionErrorCode } from "@reformaflow/domain";
import { AgentController } from "../../agent/agent.controller";
import {
  ImportAuthGuard,
  readImportAuthForRequest,
} from "./import-session.auth";
import { ImportUiGuard } from "./import-session-ui.guard";
import { ImportSessionError, importSessionWire } from "./import-session.errors";
import {
  parseImportChatTurn,
  registerPendingImportChat,
} from "./import-chat.admission";

@Injectable()
export class ImportChatGuard implements CanActivate {
  constructor(
    private readonly auth: ImportAuthGuard,
    private readonly ui: ImportUiGuard,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ body?: Record<string, unknown> }>();
    if (
      !request.body ||
      !Object.prototype.hasOwnProperty.call(request.body, "importTurn")
    )
      return true;
    try {
      if (
        context.getType() !== "http" ||
        context.getHandler() !== AgentController.prototype.chat
      )
        throw new ImportSessionError(ImportSessionErrorCode.UI_ACTION_REQUIRED);
      const turn = parseImportChatTurn(request.body.importTurn);
      this.auth.canActivate(context);
      this.ui.canActivate(context);
      registerPendingImportChat(
        request,
        readImportAuthForRequest(request),
        turn,
      );
      return true;
    } catch (error) {
      if (error instanceof ImportSessionError)
        throw new HttpException(importSessionWire(error), error.status);
      throw error;
    }
  }
}
