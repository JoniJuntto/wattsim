CREATE TABLE `csms_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`csms_url` text NOT NULL,
	`stations` integer NOT NULL,
	`total` integer NOT NULL,
	`errors` integer NOT NULL,
	`warnings` integer NOT NULL,
	`report` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `csms_reports_created_at` ON `csms_reports` (`created_at`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`run_id` text,
	`created_at` integer NOT NULL,
	`entries` integer NOT NULL,
	`skipped` integer NOT NULL,
	`trace` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recordings_created_at` ON `recordings` (`created_at`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`target` text NOT NULL,
	`csms_url` text NOT NULL,
	`virtual` integer NOT NULL,
	`speed` real,
	`seed` integer,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`error` text,
	`frames` integer DEFAULT 0 NOT NULL,
	`result` text,
	`events` text NOT NULL,
	`events_dropped` integer DEFAULT 0 NOT NULL,
	`recording_id` text
);
--> statement-breakpoint
CREATE INDEX `runs_started_at` ON `runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
