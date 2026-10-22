-- Add `agent_tasks.started_by`: the Slack user who started this task, so a
-- human-in-the-loop approval the agent later raises can mention them.
--
-- Required with no default, so existing rows are backfilled in the rebuild below
-- rather than defaulted. Same shape and the same reason as 0019 and 0021, which
-- added `tenant_id` and `task_deadline_seconds` to `agents`: a DEFAULT in the
-- live DDL would make the column optional at every future insert, so a write
-- path that forgot who started the task would quietly store a stand-in instead
-- of failing. The `'unknown'` in the INSERT below is the ONE place that value
-- appears in SQL — a one-time backfill, not a rule the table keeps.
--
-- What it backfills is the truth about those rows: they were written by code
-- that had no user id to store and nothing can recover one for them after the
-- fact. It matters because they outlive this migration — a task has until its
-- agent's `task_deadline_seconds` to come back, so some of them still raise
-- prompts afterwards. Such a prompt posts with no mention rather than pinging
-- whoever a stand-in happened to name: `unknown` is lowercase, so it fails the
-- Slack-user-id shape check in `src/slack/hitl/render.ts`, as does `process`
-- (what a feed turn for an edit or a delete records, having no actor on it to
-- ask). A sentinel rather than a nullable column, so every reader gets a string
-- and none has to decide what a missing one means.
--
-- A rebuild, not `ALTER TABLE ... ADD COLUMN`: SQLite cannot add a NOT NULL
-- column without a DEFAULT, and a DEFAULT is exactly what must not survive here.
-- Apply it with the deploy that knows about the column rather than ahead of it —
-- with nothing to fall back on, the previous version's inserts (a column list
-- that omits `started_by`) fail the NOT NULL, which is the same loud failure any
-- other write path that forgets the column gets.
--
-- Unlike 0019 and 0021 nothing has to move out of the way first: `agent_tasks` is
-- a child of `agents` and no table holds a foreign key to it, so `DROP TABLE`
-- orphans nothing and the straight rebuild 0017 used on this same table is
-- enough. The `PRAGMA foreign_keys` pair drizzle-kit emits around that rebuild
-- (and 0017 kept) is left out: D1 runs a migration inside an implicit
-- transaction and SQLite ignores `foreign_keys` inside one, so it does nothing —
-- see 0019's header for the detail. The whole file is that one transaction, so a
-- failure at any point rolls back to the pre-0023 state.
CREATE TABLE `__new_agent_tasks` (
	`token` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`agent_name` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_ts` text NOT NULL,
	`reply_thread_ts` text,
	`event_id` text NOT NULL,
	`started_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`cancel_requested` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`received_message_ids` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`agent_name`) REFERENCES `agents`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agent_tasks`("token", "task_id", "agent_name", "channel_id", "message_ts", "reply_thread_ts", "event_id", "started_by", "status", "cancel_requested", "last_error", "received_message_ids", "created_at", "completed_at") SELECT "token", "task_id", "agent_name", "channel_id", "message_ts", "reply_thread_ts", "event_id", 'unknown', "status", "cancel_requested", "last_error", "received_message_ids", "created_at", "completed_at" FROM `agent_tasks`;--> statement-breakpoint
DROP TABLE `agent_tasks`;--> statement-breakpoint
ALTER TABLE `__new_agent_tasks` RENAME TO `agent_tasks`;--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_created_at` ON `agent_tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_channel_message_ts` ON `agent_tasks` (`channel_id`,`message_ts`);--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_event_id` ON `agent_tasks` (`event_id`);
