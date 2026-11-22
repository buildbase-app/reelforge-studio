-- AlterTable
ALTER TABLE `Job` ADD COLUMN `runId` VARCHAR(191) NULL;

-- Backfill (#184): render and preview jobs written before this migration get their run id from params.
UPDATE `Job` SET `runId` = JSON_UNQUOTE(JSON_EXTRACT(`params`, '$.runId')) WHERE `type` IN ('render', 'preview') AND `runId` IS NULL;

-- CreateIndex
CREATE INDEX `Job_workspaceId_runId_idx` ON `Job`(`workspaceId`, `runId`);
