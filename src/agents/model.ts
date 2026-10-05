import type { LanguageModel } from "ai";
import {
  gatewayLogFields,
  workersAIModel,
  type GatewayCorrelation
} from "@dynamicagents/core/model";
import { AI_GATEWAY_ID, CHAT_MODEL } from "@/config";

/**
 * The one model a built-in agent runs, as its `getModel()` returns it.
 *
 * One function for every call site, because what a call tells AI Gateway about
 * itself has to be spelled the same way everywhere or a log filter on it
 * silently misses the calls that spelled it differently.
 *
 * `sessionAffinity` is the Durable Object's name: every call an object makes
 * re-sends one history, so the prefix cache wants that grain and no finer.
 */
export function agentModel(
  env: Env,
  name: string,
  correlation: GatewayCorrelation
): LanguageModel {
  return workersAIModel(env, {
    modelId: CHAT_MODEL.id,
    gatewayId: AI_GATEWAY_ID,
    reasoningEffort: CHAT_MODEL.reasoningEffort,
    sessionAffinity: name,
    ...gatewayLogFields(correlation)
  });
}
