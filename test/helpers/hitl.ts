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

/** A one-question form asking a person to approve an artifact. */
export function approvalForm(
  requestId: string,
  prompt = "Approve the plan?"
): HitlRequestData {
  return {
    type: HITL_REQUEST_TYPE,
    requestId,
    questions: [
      {
        kind: "approval",
        id: "q1",
        prompt,
        artifact: { id: "plan-1", url: "https://agents.example/a/tok" }
      }
    ]
  };
}
