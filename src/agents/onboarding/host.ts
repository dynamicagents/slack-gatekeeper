import { TaskHost } from "@dynamicagents/core/task";
import { copy } from "../copy";

/**
 * The onboarding tenant's task host, one per direct-message channel, named by
 * the caller scope core composes from this gatekeeper's origin and the identity
 * key dispatch mints (`{origin}#onboarding:{dmChannelId}`);
 * `OnboardingWorkflow` runs its tasks.
 */
export class OnboardingHost extends TaskHost<Env> {
  protected readonly copy = copy;
  protected readonly workflowBinding: string = "ONBOARDING_WORKFLOW";
  protected readonly hostBinding: string = "OnboardingHost";
}
