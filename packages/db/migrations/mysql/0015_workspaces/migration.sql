-- AlterTable
ALTER TABLE `Workspace` ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `limits` TEXT NULL,
    ADD COLUMN `purgeAfter` DATETIME(3) NULL,
    ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    ADD COLUMN `suspendedAt` DATETIME(3) NULL,
    ADD COLUMN `updatedAt` DATETIME(3) NULL;

-- Data (#304): admin keys made before workspaces ran the whole install; they keep that power as the new
-- instance-level "owner" scope. Admin keys made from now on manage only their own workspace.
UPDATE `ApiKey` SET `scopes` = REPLACE(`scopes`, '"admin"', '"admin","owner"') WHERE `scopes` LIKE '%"admin"%' AND `scopes` NOT LIKE '%"owner"%';
