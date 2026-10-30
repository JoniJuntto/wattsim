CREATE TABLE `site_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`run_id` text,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`controller` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`nodes` integer NOT NULL,
	`leaves` integer NOT NULL,
	`trips` integer NOT NULL,
	`peak_node` text,
	`peak_pct` real,
	`fairness` real,
	`report` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `site_reports_created_at` ON `site_reports` (`created_at`);--> statement-breakpoint
CREATE INDEX `site_reports_run_id` ON `site_reports` (`run_id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `site_id` text;