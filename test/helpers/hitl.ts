import {
  HITL_REQUEST_TYPE,
  type HitlOption,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";

/** A one-question form picking among `options` — Approve and Reject by default. */
export function choiceForm(
  requestId: string,
  prompt = "Proceed?",
  options: HitlOption[] = [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject" }
  ]
): HitlRequestData {
  return {
    type: HITL_REQUEST_TYPE,
    requestId,
    questions: [{ kind: "choice", id: "q1", prompt, options }]
  };
}
