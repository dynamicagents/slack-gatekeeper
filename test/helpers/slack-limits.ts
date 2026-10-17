import { isRecord } from "@/util/json";

/**
 * Slack's Block Kit limits, as a check a stub can run on what it is sent.
 *
 * A Slack stub that answers `ok: true` to anything passes a payload real Slack
 * refuses — which is how an answer past a section's 3,000 characters shipped.
 * The numbers are Slack's documented ones, plus the observed total a message's
 * blocks may hold (`msg_blocks_too_long`), which Slack does not document.
 */

const LIMITS = {
  messageBlocks: 50,
  viewBlocks: 100,
  /** Observed: Slack refuses a message whose blocks hold about this much text. */
  messageText: 13_000,
  sectionText: 3_000,
  contextElements: 10,
  textObject: 3_000,
  fields: 10,
  fieldText: 2_000,
  actionsElements: 25,
  buttonText: 75,
  buttonValue: 2_000,
  optionText: 75,
  optionValue: 150,
  selectOptions: 100,
  radioOptions: 10,
  checkboxOptions: 10,
  inputLabel: 2_000,
  inputHint: 2_000,
  placeholder: 150,
  textInputMaxLength: 3_000,
  id: 255,
  viewTitle: 24,
  privateMetadata: 3_000
};

function textOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.text === "string"
    ? value.text
    : undefined;
}

function checkText(
  out: string[],
  where: string,
  value: unknown,
  max: number
): number {
  const text = textOf(value);
  if (text === undefined) return 0;
  if (text.length === 0) out.push(`${where}: empty text`);
  if (text.length > max) out.push(`${where}: ${text.length} > ${max}`);
  return text.length;
}

function checkId(out: string[], where: string, value: unknown): void {
  if (typeof value === "string" && value.length > LIMITS.id) {
    out.push(`${where}: id ${value.length} > ${LIMITS.id}`);
  }
}

function checkOptions(
  out: string[],
  where: string,
  options: unknown,
  max: number
): void {
  if (!Array.isArray(options)) return;
  if (options.length > max) {
    out.push(`${where}: ${options.length} options > ${max}`);
  }
  options.forEach((o, i) => {
    if (!isRecord(o)) return;
    checkText(out, `${where}.options[${i}].text`, o.text, LIMITS.optionText);
    checkText(
      out,
      `${where}.options[${i}].description`,
      o.description,
      LIMITS.optionText
    );
    if (typeof o.value === "string" && o.value.length > LIMITS.optionValue) {
      out.push(`${where}.options[${i}].value: > ${LIMITS.optionValue}`);
    }
  });
}

function checkElement(out: string[], where: string, element: unknown): void {
  if (!isRecord(element)) return;
  checkId(out, `${where}.action_id`, element.action_id);
  checkText(
    out,
    `${where}.placeholder`,
    element.placeholder,
    LIMITS.placeholder
  );
  switch (element.type) {
    case "button":
      checkText(out, `${where}.text`, element.text, LIMITS.buttonText);
      if (
        typeof element.value === "string" &&
        element.value.length > LIMITS.buttonValue
      ) {
        out.push(`${where}.value: > ${LIMITS.buttonValue}`);
      }
      return;
    case "static_select":
    case "multi_static_select":
      checkOptions(out, where, element.options, LIMITS.selectOptions);
      return;
    case "radio_buttons":
      checkOptions(out, where, element.options, LIMITS.radioOptions);
      return;
    case "checkboxes":
      checkOptions(out, where, element.options, LIMITS.checkboxOptions);
      return;
    case "plain_text_input":
      if (
        typeof element.max_length === "number" &&
        element.max_length > LIMITS.textInputMaxLength
      ) {
        out.push(`${where}.max_length: > ${LIMITS.textInputMaxLength}`);
      }
      return;
  }
}

/** How many characters of text a block holds, after recording its violations. */
function checkBlock(out: string[], where: string, block: unknown): number {
  if (!isRecord(block)) {
    out.push(`${where}: not an object`);
    return 0;
  }
  checkId(out, `${where}.block_id`, block.block_id);
  let chars = 0;
  switch (block.type) {
    case "section": {
      chars += checkText(out, `${where}.text`, block.text, LIMITS.sectionText);
      if (Array.isArray(block.fields)) {
        if (block.fields.length > LIMITS.fields) {
          out.push(`${where}.fields: > ${LIMITS.fields}`);
        }
        block.fields.forEach((f, i) => {
          chars += checkText(out, `${where}.fields[${i}]`, f, LIMITS.fieldText);
        });
      }
      if (block.accessory)
        checkElement(out, `${where}.accessory`, block.accessory);
      return chars;
    }
    case "context": {
      const elements = Array.isArray(block.elements) ? block.elements : [];
      if (elements.length > LIMITS.contextElements) {
        out.push(`${where}.elements: > ${LIMITS.contextElements}`);
      }
      elements.forEach((e, i) => {
        chars += checkText(
          out,
          `${where}.elements[${i}]`,
          e,
          LIMITS.textObject
        );
      });
      return chars;
    }
    case "actions": {
      const elements = Array.isArray(block.elements) ? block.elements : [];
      if (elements.length > LIMITS.actionsElements) {
        out.push(`${where}.elements: > ${LIMITS.actionsElements}`);
      }
      elements.forEach((e, i) =>
        checkElement(out, `${where}.elements[${i}]`, e)
      );
      return 0;
    }
    case "input":
      chars += checkText(out, `${where}.label`, block.label, LIMITS.inputLabel);
      chars += checkText(out, `${where}.hint`, block.hint, LIMITS.inputHint);
      checkElement(out, `${where}.element`, block.element);
      return chars;
    default:
      return 0;
  }
}

/** Every way `blocks` breaks Slack's limits for a message; empty when it fits. */
export function messageViolations(blocks: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(blocks)) return ["blocks: not an array"];
  if (blocks.length > LIMITS.messageBlocks) {
    out.push(`blocks: ${blocks.length} > ${LIMITS.messageBlocks}`);
  }
  const chars = blocks.reduce<number>(
    (sum, b, i) => sum + checkBlock(out, `blocks[${i}]`, b),
    0
  );
  if (chars > LIMITS.messageText) {
    out.push(`blocks: ${chars} characters in all > ${LIMITS.messageText}`);
  }
  return out;
}

/** Every way a modal view breaks Slack's limits; empty when it fits. */
export function viewViolations(view: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(view)) return ["view: not an object"];
  checkText(out, "title", view.title, LIMITS.viewTitle);
  checkText(out, "submit", view.submit, LIMITS.viewTitle);
  checkText(out, "close", view.close, LIMITS.viewTitle);
  checkId(out, "callback_id", view.callback_id);
  if (
    typeof view.private_metadata === "string" &&
    view.private_metadata.length > LIMITS.privateMetadata
  ) {
    out.push(`private_metadata: > ${LIMITS.privateMetadata}`);
  }
  const blocks = Array.isArray(view.blocks) ? view.blocks : [];
  if (blocks.length > LIMITS.viewBlocks) {
    out.push(`blocks: ${blocks.length} > ${LIMITS.viewBlocks}`);
  }
  blocks.forEach((b, i) => checkBlock(out, `blocks[${i}]`, b));
  return out;
}

/** All the text a message's blocks show, joined, for asserting nothing was dropped. */
export function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap((b) => {
      if (!isRecord(b)) return [];
      const texts = [textOf(b.text), textOf(b.label)];
      if (Array.isArray(b.elements)) texts.push(...b.elements.map(textOf));
      return texts.filter((t): t is string => t !== undefined);
    })
    .join("\n");
}
