import {
  ImportChatContractError,
  parseImportToolArguments,
  type ImportToolArguments,
} from "./import-chat.contract";
import type { ToolCall, ToolDef } from "./llm/llm.types";

/** Test-only equivalent of contextual's pre-execution batch checks. No tools execute here. */
export function validateSyntheticCallBatch(
  calls: ToolCall[],
  definitions: ToolDef[],
): { call: ToolCall; parsed: ImportToolArguments }[] {
  const allowed = new Set(definitions.map((definition) => definition.name));
  const parsed = calls.map((call) => {
    if (!allowed.has(call.name))
      throw new ImportChatContractError("TOOL_NOT_ALLOWED");
    return {
      call,
      parsed: parseImportToolArguments(call.name, call.arguments),
    };
  });
  const writes = parsed.filter(
    (item) => item.parsed.name === "import_edit_answer",
  );
  if (
    !parsed.length ||
    writes.length > 1 ||
    (writes.length === 1 && parsed[parsed.length - 1] !== writes[0])
  )
    throw new ImportChatContractError("MODEL_OUTPUT_INVALID");
  return parsed;
}
