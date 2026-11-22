-- CreateTable
CREATE TABLE `WebhookEndpoint` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `type` VARCHAR(191) NOT NULL,
    `url` TEXT NULL,
    `urlScheme` VARCHAR(191) NULL,
    `urlDisplay` TEXT NULL,
    `email` TEXT NULL,
    `events` TEXT NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `disabledReason` TEXT NULL,
    `secret` TEXT NULL,
    `secretScheme` VARCHAR(191) NULL,
    `prevSecret` TEXT NULL,
    `prevSecretScheme` VARCHAR(191) NULL,
    `prevSecretExpiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdBy` VARCHAR(191) NULL,

    INDEX `WebhookEndpoint_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebhookDelivery` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `endpointId` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `payload` LONGTEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL,
    `lockedUntil` DATETIME(3) NULL,
    `lastStatus` INTEGER NULL,
    `lastError` TEXT NULL,
    `deliveredAt` DATETIME(3) NULL,
    `replayOf` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WebhookDelivery_workspaceId_status_nextAttemptAt_idx`(`workspaceId`, `status`, `nextAttemptAt`),
    INDEX `WebhookDelivery_workspaceId_endpointId_id_idx`(`workspaceId`, `endpointId`, `id`),
    INDEX `WebhookDelivery_workspaceId_status_updatedAt_idx`(`workspaceId`, `status`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebhookAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `deliveryId` VARCHAR(191) NOT NULL,
    `endpointId` VARCHAR(191) NOT NULL,
    `attempt` INTEGER NOT NULL,
    `at` DATETIME(3) NOT NULL,
    `durationMs` INTEGER NOT NULL,
    `status` INTEGER NULL,
    `error` TEXT NULL,
    `outcome` VARCHAR(191) NOT NULL,

    INDEX `WebhookAttempt_workspaceId_deliveryId_idx`(`workspaceId`, `deliveryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WebhookEndpoint` ADD CONSTRAINT `WebhookEndpoint_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebhookDelivery` ADD CONSTRAINT `WebhookDelivery_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebhookAttempt` ADD CONSTRAINT `WebhookAttempt_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
