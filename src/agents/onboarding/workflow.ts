import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  TaskWorkflow,
  type PipelineResult,
  type TaskParams,
  type TaskStep
} from "@dynamicagents/core/workflow";

/** Onboarding's pipeline: one step, the whole task, on the person's `OnboardingStepAgent`. */
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
      input: event.payload.text
    });
    return { reply };
  }
}
