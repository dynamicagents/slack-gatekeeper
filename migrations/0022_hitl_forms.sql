-- `hitl_forms` replaces `hitl_requests` now that a prompt is a form: the whole
-- request is kept as JSON, and the answers keyed by question.
--
-- A new table rather than a rebuild: the Worker still live while this runs
-- writes `hitl_requests`, whose NOT NULL `request_kind` and `prompt_text` the new
-- code has nothing to put in. Questions open at the cutover are not carried over.
-- `hitl_requests` is dropped by a later migration, once no live Worker writes it.
--
-- Like `hitl_requests`, this holds a FK to `agents.name`, so a rebuild of
-- `agents` moves its rows aside first, as 0021 does.
CREATE TABLE `hitl_forms` (
	`request_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`task_id` text,
	`context_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_ts` text,
	`slack_message_ts` text,
	`request_json` text NOT NULL,
	`status` text DEFAULT 'awaiting' NOT NULL,
	`answered_by` text,
	`answers_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`deadline_at` integer NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`agent_name`) REFERENCES `agents`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_hitl_forms_token` ON `hitl_forms` (`token`);--> statement-breakpoint
CREATE INDEX `idx_hitl_forms_status_deadline` ON `hitl_forms` (`status`,`deadline_at`);--> statement-breakpoint
CREATE INDEX `idx_hitl_forms_created_at` ON `hitl_forms` (`created_at`);