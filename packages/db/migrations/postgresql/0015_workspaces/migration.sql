-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "limits" TEXT,
ADD COLUMN     "purgeAfter" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- Data (#304): admin keys made before workspaces ran the whole install; they keep that power as the new
-- instance-level "owner" scope. Admin keys made from now on manage only their own workspace.
UPDATE "ApiKey" SET "scopes" = REPLACE("scopes", '"admin"', '"admin","owner"') WHERE "scopes" LIKE '%"admin"%' AND "scopes" NOT LIKE '%"owner"%';
