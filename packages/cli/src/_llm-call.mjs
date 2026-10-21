// Thin re-export of DelendAI's REAL callLlm so complete-bridge uses the source
// of truth (llm-client.service.ts), not a copy.
export {
  callLlm,
  callLlmFanOut,
} from "../../../plugins/audit/src/lib/services/llm-client.service.ts";