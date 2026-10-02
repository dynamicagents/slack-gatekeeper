-- Add `agents.task_deadline_seconds`: how long THIS agent gets to finish one
-- processing leg before the ReactionWorkflow cancels its task and tells the
-- channel. Required — there is no "no limit", so no row may be without one.
--
-- Required with no default, so existing rows are backfilled in the rebuild below
-- rather than defaulted. Same shape and the same reason as 0019, which added
-- `tenant_id` to this table: a DEFAULT in the live DDL would make the column
-- optional at every future insert, and it would leave a second copy of the number
-- in the database for anyone raising the constant in `src/config.ts` to wonder
-- about. The `3600` in the INSERT below is the ONE place it appears in SQL — a
-- one-time backfill of the hour those rows already had, not a rule the table
-- keeps. After this migration the table's DDL has no DEFAULT on this column and
-- `DEFAULT_TASK_DEADLINE_SECONDS` is the only default that exists; `registerAgent`
-- passes it explicitly on every insert.
--
-- That backfill is also what covers the built-ins. 0001 seeds `admin` and
-- `onboarding` with a column list that predates this one (as it predates
-- `tenant_id` and `notify_on`), so the seed itself needs no change: those rows are
-- already in `agents` by the time this runs and the copy step gives them 3600.
--
-- A rebuild, not `ALTER TABLE ... ADD COLUMN`: SQLite cannot add a NOT NULL column
-- without a DEFAULT, and a DEFAULT is exactly what must not survive here.
--
-- The `PRAGMA foreign_keys=OFF` drizzle-kit emits for a rebuild does nothing: D1
-- runs a migration inside an implicit transaction, and SQLite ignores
-- `foreign_keys` inside one. `DROP TABLE agents` then performs an implicit DELETE
-- that orphans every child row — agent_channels, agent_tasks and hitl_requests all
-- hold a FK to agents.name — and the migration dies with FOREIGN KEY constraint
-- failed.
--
-- `PRAGMA defer_foreign_keys`, D1's documented replacement, is not enough on its
-- own. It only moves the check to the commit: DROP TABLE increments SQLite's
-- deferred-violation counter once per orphaned row, and renaming a new `agents`
-- into place never decrements it, because nothing re-examines those rows. The
-- same error arrives a moment later.
--
-- So the children move out of the way first, exactly as 0019 did. The whole file
-- is one transaction, so they are never observably empty and a failure at any
-- point rolls back to the pre-0021 state.
CREATE TABLE `__bkp_agent_channels` AS SELECT * FROM `agent_channels`;--> statement-breakpoint
CREATE TABLE `__bkp_agent_tasks` AS SELECT * FROM `agent_tasks`;--> statement-breakpoint
CREATE TABLE `__bkp_hitl_requests` AS SELECT * FROM `hitl_requests`;--> statement-breakpoint
DELETE FROM `agent_channels`;--> statement-breakpoint
DELETE FROM `agent_tasks`;--> statement-breakpoint
DELETE FROM `hitl_requests`;--> statement-breakpoint

-- Both CHECKs name their column unqualified, as 0011 and 0019 wrote them.
-- Qualified, they would say `__new_agents` and the surviving constraint would
-- depend on ALTER TABLE RENAME rewriting the reference; nothing here needs the
-- qualifier.
CREATE TABLE `__new_agents` (
	`name` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`icon_url` text,
	`a2a_endpoint` text NOT NULL,
	`tenant_id` text NOT NULL,
	`card_signing_jku` text,
	`card_signing_kid` text,
	`enabled` integer DEFAULT true NOT NULL,
	`notify_on` text NOT NULL,
	`task_deadline_seconds` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agents_name_lowercase" CHECK("name" = lower("name")),
	CONSTRAINT "agents_tenant_id_nonempty" CHECK("tenant_id" <> '')
);
--> statement-breakpoint
INSERT INTO `__new_agents`("name", "kind", "display_name", "icon_url", "a2a_endpoint", "tenant_id", "card_signing_jku", "card_signing_kid", "enabled", "notify_on", "task_deadline_seconds", "workspace_id", "created_at", "updated_at") SELECT "name", "kind", "display_name", "icon_url", "a2a_endpoint", "tenant_id", "card_signing_jku", "card_signing_kid", "enabled", "notify_on", 3600, "workspace_id", "created_at", "updated_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
CREATE INDEX `idx_agents_workspace_id` ON `agents` (`workspace_id`);--> statement-breakpoint

-- Restore the children. Every agent name survived the rebuild unchanged, so
-- each row finds the parent it had before.
INSERT INTO `agent_channels` SELECT * FROM `__bkp_agent_channels`;--> statement-breakpoint
INSERT INTO `agent_tasks` SELECT * FROM `__bkp_agent_tasks`;--> statement-breakpoint
INSERT INTO `hitl_requests` SELECT * FROM `__bkp_hitl_requests`;--> statement-breakpoint
DROP TABLE `__bkp_agent_channels`;--> statement-breakpoint
DROP TABLE `__bkp_agent_tasks`;--> statement-breakpoint
DROP TABLE `__bkp_hitl_requests`;
