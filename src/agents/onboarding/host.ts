import { TaskHost } from "@dynamicagents/core/task";
import { copy } from "../copy";

/**
 * The onboarding tenant's task host, one per direct-message channel
 * (`onboarding:{dmChannelId}`);
 * `OnboardingWorkflow` runs its tasks.
 */
export class OnboardingHost extends TaskHost<Env> {
  protected readonly copy = copy;
  protected readonly workflowBinding: string = "ONBOARDING_WORKFLOW";
  protected readonly hostBinding: string = "OnboardingHost";
}
