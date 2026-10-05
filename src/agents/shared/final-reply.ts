import { tool } from "ai";
import { z } from "zod";

/**
 * The `final_reply` **control tool** — the way a turn answers the user, and the
 * only way a turn ends on its own terms.
 *
 * A turn used to end by the model simply stopping with text, and that was the bug:
 * to the code, "the model answered the user" and "the model narrated an action it
 * never took" were the same outcome — a non-empty string. A model that wrote
 * "Done! ✅ I updated the endpoint" and emitted no call completed the turn
 * successfully, having done nothing, and the next turn read that claim back as
 * fact.
 *
 * So prose is no longer an outcome. The answer is a named tool, the turn runs with
 * `toolChoice: "required"`, and a turn that ends any other way has failed its
 * attempt. Nothing forces *which* tool the model picks — work tools stay freely
 * available on every step, and `required` constrains the shape of a step's output,
 * not the choice. Picking between named tools is also a far easier discrimination
 * for a small model than picking between prose and a tool, which is what the
 * chat models here kept getting wrong.
 *
 * Two other endings already exist and out-rank this one: a 🛑 cancel, and a pause
 * for a human (an `ask_user` question, or the `agents_delete` approval). See
 * {@link file://./loop.ts loop.ts} for the precedence.
 */

export const FINAL_REPLY_TOOL_NAME = "final_reply";

/**
 * The call's input, exported as the zod schema rather than only as the tool's
 * `inputSchema`, so the turn can read a call back with a type.
 *
 * The SDK validates against it on the way in. Every tool call is parsed against its
 * `inputSchema` — an `execute`-less control tool included — and a call that fails
 * comes back to the model on the next step as a failed tool result carrying the
 * reason, which is how a blank `text` gets fixed instead of reaching Slack as an
 * empty message. The turn never re-checks what the SDK already rejected: it reads
 * the ending off `staticToolCalls`, which holds only the calls that passed.
 */
export const finalReplyInputSchema = z.object({
  text: z
    .string()
    .refine((s) => s.trim().length > 0, "must not be blank")
    .describe(
      "Your reply, in your own voice. This is shown to the user verbatim, so it must be the complete answer and must not be blank."
    )
});

/**
 * The tool as the model sees it. **Without `execute`**: the call *is* the turn's
 * output, so there is nothing for the SDK to run and the loop halts on it.
 *
 * The call is never reconstructed in a later turn's history — a past reply is
 * stored as, and replayed as, ordinary assistant text. The tool exists to
 * constrain *generation*, not to become a new shape in the transcript.
 */
export const finalReplyTool = tool({
  description:
    "Answer the user and end this turn. Use this once you have everything you need — " +
    "either because the request was yours to answer directly, or because the tools " +
    "you called have come back and you can now report what actually happened.",
  inputSchema: finalReplyInputSchema
});

/**
 * The turn contract, appended to the soul + caller context on every turn that
 * runs with the forced ending.
 *
 * It lives beside the tool rather than in an agent's own prompt so the two cannot
 * drift: renaming the tool renames it here.
 */
export const FINAL_REPLY_CONTRACT = `

# Ending this turn

You end this turn by calling the \`${FINAL_REPLY_TOOL_NAME}\` tool with your reply. Use
the other tools first if they help — read something, make the change the user asked
for — and then call \`${FINAL_REPLY_TOOL_NAME}\` to report what happened.

**Every turn must end in a \`${FINAL_REPLY_TOOL_NAME}\` call.** Prose on its own does not
reach the user and does not perform any action.

**Announcing is not doing.** A \`${FINAL_REPLY_TOOL_NAME}\` that says what you are about
to do ends the turn instead of doing it: nothing runs after that call, and the user
has been told otherwise. If your next step is a tool call, make that call now, in
this same turn, and reply once it has come back.

Only describe an action as done if you actually called the tool and saw its result.
If a call failed, say plainly what failed — never present a partial result as
complete, and never invent an outcome for work that did not run.`;

/**
 * Appended when the turn has spent its steps. No work tools are declared in that
 * case, so this explains a constraint the model can already see rather than
 * imposing a new one.
 *
 * It names the budget on purpose. "You cannot use tools" reads as a capability to
 * route around; "you have used this turn's steps" reads as a fact, and the only
 * sensible response to it is the answer.
 *
 * One place reaches it: the loop's last step, in
 * {@link file://./loop.ts loop.ts}.
 */
export const FINAL_ROUND_CONTRACT = `

# Your steps are spent

You have used every step this turn allows. You have no tools left except one: call
\`${FINAL_REPLY_TOOL_NAME}\` now and answer from what you already have.

Report exactly what you did and what came back. If something is unfinished or
failed, say so plainly in one short sentence — do not apologize at length, and do
not describe steps, budgets, or this constraint.`;
