-- CreateTable
CREATE TABLE `Workspace` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Project` (
    `workspaceId` VARCHAR(191) NOT NULL,
    `id` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `title` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Project_workspaceId_updatedAt_idx`(`workspaceId`, `updatedAt`),
    PRIMARY KEY (`workspaceId`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProjectVersion` (
    `workspaceId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `manifest` LONGTEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`workspaceId`, `projectId`, `version`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ApiKey` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `scopes` TEXT NOT NULL,
    `prefix` VARCHAR(191) NOT NULL,
    `salt` VARCHAR(191) NOT NULL,
    `hash` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `lastUsedAt` DATETIME(3) NULL,

    INDEX `ApiKey_workspaceId_idx`(`workspaceId`),
    INDEX `ApiKey_prefix_idx`(`prefix`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Job` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NULL,
    `params` LONGTEXT NOT NULL,
    `progress` TEXT NOT NULL,
    `result` LONGTEXT NULL,
    `error` LONGTEXT NULL,
    `retryOf` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,

    INDEX `Job_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    INDEX `Job_workspaceId_projectId_idx`(`workspaceId`, `projectId`),
    INDEX `Job_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workspaceId` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `message` LONGTEXT NOT NULL,

    INDEX `JobEvent_jobId_id_idx`(`jobId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Theme` (
    `workspaceId` VARCHAR(191) NOT NULL,
    `id` VARCHAR(191) NOT NULL,
    `definition` LONGTEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`workspaceId`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProviderSetting` (
    `workspaceId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `providerId` VARCHAR(191) NULL,
    `value` TEXT NOT NULL,
    `scheme` VARCHAR(191) NOT NULL DEFAULT 'plain',
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`workspaceId`, `name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Asset` (
    `workspaceId` VARCHAR(191) NOT NULL,
    `id` VARCHAR(191) NOT NULL,
    `sha256` VARCHAR(191) NOT NULL,
    `bytes` BIGINT NOT NULL,
    `contentType` VARCHAR(191) NOT NULL,
    `mediaType` VARCHAR(191) NOT NULL,
    `storageKey` TEXT NOT NULL,
    `source` TEXT NOT NULL,
    `originalName` TEXT NULL,
    `license` TEXT NULL,
    `durationSeconds` DOUBLE NULL,
    `metadata` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL,

    INDEX `Asset_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    PRIMARY KEY (`workspaceId`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL,
    `actorType` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `targetType` VARCHAR(191) NULL,
    `targetId` VARCHAR(191) NULL,
    `data` LONGTEXT NULL,

    INDEX `AuditLog_workspaceId_at_idx`(`workspaceId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SystemState` (
    `key` VARCHAR(191) NOT NULL,
    `value` LONGTEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectVersion` ADD CONSTRAINT `ProjectVersion_workspaceId_projectId_fkey` FOREIGN KEY (`workspaceId`, `projectId`) REFERENCES `Project`(`workspaceId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ApiKey` ADD CONSTRAINT `ApiKey_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Job` ADD CONSTRAINT `Job_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JobEvent` ADD CONSTRAINT `JobEvent_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Theme` ADD CONSTRAINT `Theme_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProviderSetting` ADD CONSTRAINT `ProviderSetting_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Asset` ADD CONSTRAINT `Asset_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
