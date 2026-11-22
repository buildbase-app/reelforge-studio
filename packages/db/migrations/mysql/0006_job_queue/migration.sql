-- AlterTable
ALTER TABLE `Job` ADD COLUMN `attempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `cancelRequestedAt` DATETIME(3) NULL,
    ADD COLUMN `leaseExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `queue` VARCHAR(191) NULL,
    ADD COLUMN `workerId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `RateLimitWindow` (
    `workspaceId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `windowStart` DATETIME(3) NOT NULL,
    `count` INTEGER NOT NULL,

    INDEX `RateLimitWindow_windowStart_idx`(`windowStart`),
    PRIMARY KEY (`workspaceId`, `key`, `windowStart`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Job_workspaceId_queue_status_createdAt_idx` ON `Job`(`workspaceId`, `queue`, `status`, `createdAt`);

-- CreateIndex
CREATE INDEX `Job_status_leaseExpiresAt_idx` ON `Job`(`status`, `leaseExpiresAt`);

-- AddForeignKey
ALTER TABLE `RateLimitWindow` ADD CONSTRAINT `RateLimitWindow_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
