import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  TaskWorkflow,
  type PipelineResult,
  type TaskParams,
  type TaskStep
} from "@dynamicagents/core/workflow";
import { TASK_RECONCILE } from "@/config";

/**
 * Onboarding's pipeline: one step, the whole task, on the person's
 * `OnboardingStepAgent`.
 *
 * The step takes joins, so the next message in the direct-message thread reaches
 * the open task rather than starting a second one beside it. The gatekeeper has
 * sent joins since #143; this is the half that takes them.
 */
export class OnboardingWorkflow extends TaskWorkflow<Env> {
  /** The step agent's binding. */
  protected readonly stepAgent: string = "OnboardingStepAgent";

  override run(event: WorkflowEvent<TaskParams>, step: WorkflowStep) {
    return super.run(event, step);
  }

  protected async pipeline(
    event: WorkflowEvent<TaskParams>,
    step: TaskStep
  ): Promise<PipelineResult> {
    const reply = await step.agent("main", {
      agent: this.stepAgent,
      input: event.payload.text,
      joins: true,
      reconcile: TASK_RECONCILE
    });
    return { reply };
  }
}
