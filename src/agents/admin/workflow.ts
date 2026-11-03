import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  TaskWorkflow,
  type PipelineResult,
  type TaskParams,
  type TaskStep
} from "@dynamicagents/core/workflow";
import { TASK_RECONCILE } from "@/config";

/**
 * The admin's pipeline: one step, the whole task, on the workspace's
 * `AdminStepAgent`.
 *
 * The step takes joins, so a reply in the thread reaches the task the admin
 * already has open rather than starting a second one beside it. The gatekeeper
 * has sent joins since #143; this is the half that takes them.
 */
export class AdminWorkflow extends TaskWorkflow<Env> {
  /** The step agent's binding. */
  protected readonly stepAgent: string = "AdminStepAgent";

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
