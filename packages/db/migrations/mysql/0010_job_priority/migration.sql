-- AlterTable
ALTER TABLE `ApiKey` ADD COLUMN `maxPriority` VARCHAR(191) NULL;

-- AlterTable (D-103): claim class, 0 interactive, 1 standard, 2 batch.
ALTER TABLE `Job` ADD COLUMN `priority` INTEGER NOT NULL DEFAULT 1;

-- Backfill (D-103): previews are interactive by default (queued ones are then claimed in the new order).
UPDATE `Job` SET `priority` = 0 WHERE `type` = 'preview';

-- CreateIndex
CREATE INDEX `Job_workspaceId_queue_status_priority_createdAt_idx` ON `Job`(`workspaceId`, `queue`, `status`, `priority`, `createdAt`);
