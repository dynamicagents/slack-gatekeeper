import { TaskHost } from "@dynamicagents/core/task";
import { copy } from "../copy";

/**
 * The admin tenant's task host: it owns each A2A task the gatekeeper hands the
 * admin, and `AdminWorkflow` runs it. One instance per workspace, named by the
 * identity key dispatch mints (`admin:{wsId}`).
 */
export class AdminHost extends TaskHost<Env> {
  protected readonly copy = copy;
  protected readonly workflowBinding: string = "ADMIN_WORKFLOW";
  protected readonly hostBinding: string = "AdminHost";
}
