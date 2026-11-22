-- AlterTable
ALTER TABLE `Job` ADD COLUMN `parentId` VARCHAR(191) NULL,
    ADD COLUMN `pendingChildren` INTEGER NULL;

-- CreateIndex
CREATE INDEX `Job_parentId_idx` ON `Job`(`parentId`);
