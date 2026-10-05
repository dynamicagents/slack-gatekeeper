import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  TaskWorkflow,
  type PipelineResult,
  type TaskParams,
  type TaskStep
} from "@dynamicagents/core/workflow";

/** The admin's pipeline: one step, the whole task, on the workspace's `AdminStepAgent`. */
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
      input: event.payload.text
    });
    return { reply };
  }
}
