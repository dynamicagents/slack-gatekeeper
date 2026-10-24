-- One open task per agent and thread. A later message in a thread joins the
-- task its agent has open there; two messages a moment apart would both find
-- the thread empty and start two, so the second's insert has to lose. The
-- thread is keyed as `getOpenAgentTaskInThread` keys it: a reply's thread, or
-- a top-level message's own ts.
--
-- `opened_beside` marks the one row allowed to share a thread: a task started
-- because the open one refused the message, as an agent that takes no joined
-- messages does. A DEFAULT is right here, unlike 0023's column: a write path
-- that forgets it is held to the index, which is the safe side.
--
-- Hand-written: drizzle-kit splits the `coalesce` expression at its comma and
-- quotes each half. The snapshot beside it records the index as written here.
--
-- Creating the index fails while two open rows already share a thread, so it
-- applies with no task open, as the deploy that brings it does.
ALTER TABLE `agent_tasks` ADD `opened_beside` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_tasks_open_thread` ON `agent_tasks` (`agent_name`, `channel_id`, coalesce(`reply_thread_ts`, `message_ts`)) WHERE `status` IN ('pending', 'awaiting-input') AND `opened_beside` = 0;
