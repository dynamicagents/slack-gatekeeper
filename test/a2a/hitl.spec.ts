import { describe, it, expect } from "vitest";
import { Role, type Message } from "@a2a-js/sdk";
import type { HitlAnswer } from "@dynamicagents/g2a-protocol";
import {
  buildMessage,
  dataOf,
  dataPart,
  partsText,
  textPart
} from "@/a2a/parts";
import {
  answeredQuestions,
  answersText,
  buildHitlRequestParts,
  buildHitlResponseParts,
  buildHitlTimeoutParts,
  parseHitlRequest,
  parseHitlResponse,
  parseHitlTimeout,
  type HitlRequest,
  HITL_REQUEST_TYPE,
  HITL_RESPONSE_TYPE,
  HITL_TIMEOUT_TYPE
} from "@/a2a/hitl";
import { choiceForm } from "../helpers/hitl";

function msg(parts: Message["parts"]): Message {
  return buildMessage({ messageId: "m1", role: Role.ROLE_AGENT, parts });
}

const form: HitlRequest = {
  type: HITL_REQUEST_TYPE,
  requestId: "req-form",
  questions: [
    {
      kind: "choice",
      id: "q1",
      prompt: "Which database?",
      header: "Database",
      options: [
        { id: "q1.o1", label: "Postgres" },
        { id: "q1.o2", label: "SQLite" }
      ]
    },
    { kind: "text", id: "q2", prompt: "What should it be called?" },
    {
      kind: "approval",
      id: "q3",
      prompt: "Approve the plan?",
      artifact: { id: "plan-1", url: "https://agents.example/a/tok" }
    }
  ]
};

describe("parseHitlRequest", () => {
  it("extracts a valid form", () => {
    const req = parseHitlRequest(msg([textPart("Proceed?"), dataPart(form)]));
    expect(req).toEqual(form);
  });

  it("returns null when no HITL data part is present", () => {
    expect(parseHitlRequest(msg([textPart("hi")]))).toBeNull();
  });

  it("returns null for a data part of a different type", () => {
    expect(
      parseHitlRequest(msg([dataPart({ type: "something.else", x: 1 })]))
    ).toBeNull();
  });

  it("returns null for a form asking nothing, or one with no requestId", () => {
    for (const bad of [
      { type: HITL_REQUEST_TYPE, requestId: "r", questions: [] },
      { type: HITL_REQUEST_TYPE, questions: form.questions },
      // An approval with nothing to look at.
      {
        type: HITL_REQUEST_TYPE,
        requestId: "r",
        questions: [{ kind: "approval", id: "q1", prompt: "OK?" }]
      }
    ]) {
      expect(parseHitlRequest(msg([dataPart(bad)]))).toBeNull();
    }
  });

  it("returns null for an undefined message", () => {
    expect(parseHitlRequest(undefined)).toBeNull();
  });

  it("prefers the first valid data part and ignores non-HITL data", () => {
    const req = parseHitlRequest(
      msg([dataPart({ type: "noise" }), dataPart(choiceForm("req-x"))])
    );
    expect(req?.requestId).toBe("req-x");
  });
});

describe("the answers in words", () => {
  const answers: Record<string, HitlAnswer> = {
    q1: { optionIds: ["q1.o1"], text: "with pgvector" },
    q2: { text: "forms" },
    q3: { optionIds: ["approve"] }
  };

  it("names each picked option by its label, and an approval by its verdict", () => {
    expect(
      answeredQuestions(form, answers).map((a) => [
        a.question.id,
        a.picked,
        a.text
      ])
    ).toEqual([
      ["q1", ["Postgres"], "with pgvector"],
      ["q2", [], "forms"],
      ["q3", ["Approved"], undefined]
    ]);
  });

  it("puts each answer under its question, by header where there is one", () => {
    expect(answersText(form, answers)).toBe(
      [
        "Database\nPostgres\nwith pgvector",
        "What should it be called?\nforms",
        "Approve the plan?\nApproved"
      ].join("\n\n")
    );
  });

  it("gives one question's answer alone", () => {
    expect(
      answersText(choiceForm("r"), { q1: { optionIds: ["approve"] } })
    ).toBe("Approve");
  });
});

describe("buildHitlResponseParts", () => {
  it("builds the answers in words plus a structured response DataPart", () => {
    const answers: Record<string, HitlAnswer> = {
      q1: { optionIds: ["reject"], text: "not yet" }
    };
    const parts = buildHitlResponseParts({
      request: choiceForm("req-1"),
      answeredBy: "U1",
      answers
    });
    expect(partsText(parts)).toBe("Reject\nnot yet");
    expect(parts.map(dataOf).find((d) => d !== undefined)).toEqual({
      type: HITL_RESPONSE_TYPE,
      requestId: "req-1",
      answeredBy: "U1",
      answers
    });
  });
});

describe("buildHitlTimeoutParts", () => {
  it("carries the timeout data part and a human fallback", () => {
    const parts = buildHitlTimeoutParts("req-3");
    expect(parts.map(dataOf).find((d) => d !== undefined)).toEqual({
      type: HITL_TIMEOUT_TYPE,
      requestId: "req-3"
    });
    expect(partsText(parts)).toContain("No response");
  });
});

describe("buildHitlRequestParts", () => {
  it("carries a text-part fallback plus the request data part, and round-trips", () => {
    const parts = buildHitlRequestParts(form);
    expect(partsText(parts)).toContain("Which database?");
    expect(parseHitlRequest(msg(parts))).toEqual(form);
  });
});

describe("parseHitlResponse", () => {
  it("extracts answers keyed by question", () => {
    const res = parseHitlResponse(
      msg([
        dataPart({
          type: HITL_RESPONSE_TYPE,
          requestId: "req-1",
          answeredBy: "U1",
          answers: { q1: { optionIds: ["a"] }, q2: { text: "typed" } }
        })
      ])
    );
    expect(res?.answers).toEqual({
      q1: { optionIds: ["a"] },
      q2: { text: "typed" }
    });
    expect(parseHitlResponse(msg([textPart("hi")]))).toBeNull();
  });

  it("returns null for an answer with neither options nor text", () => {
    for (const answers of [{ q1: {} }, { q1: { optionIds: [] } }, undefined]) {
      expect(
        parseHitlResponse(
          msg([
            dataPart({
              type: HITL_RESPONSE_TYPE,
              requestId: "req-1",
              answeredBy: "U1",
              answers
            })
          ])
        )
      ).toBeNull();
    }
  });
});

describe("parseHitlTimeout", () => {
  it("extracts the requestId and returns null when absent", () => {
    expect(parseHitlTimeout(msg(buildHitlTimeoutParts("req-9")))).toEqual({
      requestId: "req-9"
    });
    expect(parseHitlTimeout(msg([textPart("hi")]))).toBeNull();
  });
});
