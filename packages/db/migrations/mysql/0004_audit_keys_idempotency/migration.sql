-- AlterTable
ALTER TABLE `ApiKey` ADD COLUMN `expiresAt` DATETIME(3) NULL,
    ADD COLUMN `ipAllowlist` TEXT NULL,
    ADD COLUMN `prevExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `prevHash` VARCHAR(191) NULL,
    ADD COLUMN `prevPrefix` VARCHAR(191) NULL,
    ADD COLUMN `prevSalt` VARCHAR(191) NULL,
    ADD COLUMN `rateLimitPerMinute` INTEGER NULL,
    ADD COLUMN `rendersPerDay` INTEGER NULL,
    ADD COLUMN `rendersPerMonth` INTEGER NULL,
    ADD COLUMN `revokedAt` DATETIME(3) NULL,
    ADD COLUMN `rotatedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `Job` ADD COLUMN `apiKeyId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `AuditLog` ADD COLUMN `actorName` VARCHAR(191) NULL,
    ADD COLUMN `ip` VARCHAR(191) NULL,
    ADD COLUMN `requestId` VARCHAR(191) NULL,
    ADD COLUMN `result` VARCHAR(191) NOT NULL DEFAULT 'success',
    ADD COLUMN `userAgent` TEXT NULL;

-- CreateTable
CREATE TABLE `IdempotencyKey` (
    `workspaceId` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `operation` VARCHAR(191) NOT NULL,
    `requestHash` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `response` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `IdempotencyKey_workspaceId_expiresAt_idx`(`workspaceId`, `expiresAt`),
    PRIMARY KEY (`workspaceId`, `actorId`, `key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ApiKey_prevPrefix_idx` ON `ApiKey`(`prevPrefix`);

-- CreateIndex
CREATE INDEX `Job_workspaceId_apiKeyId_createdAt_idx` ON `Job`(`workspaceId`, `apiKeyId`, `createdAt`);

-- CreateIndex
CREATE INDEX `AuditLog_workspaceId_action_at_idx` ON `AuditLog`(`workspaceId`, `action`, `at`);

-- CreateIndex
CREATE INDEX `AuditLog_workspaceId_actorId_at_idx` ON `AuditLog`(`workspaceId`, `actorId`, `at`);

-- AddForeignKey
ALTER TABLE `IdempotencyKey` ADD CONSTRAINT `IdempotencyKey_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
