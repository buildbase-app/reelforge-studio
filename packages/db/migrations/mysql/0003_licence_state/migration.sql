-- CreateTable
CREATE TABLE `LicenceState` (
    `workspaceId` VARCHAR(191) NOT NULL,
    `instanceId` VARCHAR(191) NOT NULL,
    `keyHash` VARCHAR(191) NULL,
    `answer` LONGTEXT NULL,
    `lastCheckedAt` DATETIME(3) NULL,
    `lastSuccessAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `activatedAt` DATETIME(3) NULL,
    `deactivatedAt` DATETIME(3) NULL,
    `nextCheckAt` DATETIME(3) NULL,
    `highWaterAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`workspaceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LicenceState` ADD CONSTRAINT `LicenceState_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
