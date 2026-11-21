-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "ApiKey" ADD COLUMN "ipAllowlist" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "prevExpiresAt" DATETIME;
ALTER TABLE "ApiKey" ADD COLUMN "prevHash" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "prevPrefix" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "prevSalt" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "rateLimitPerMinute" INTEGER;
ALTER TABLE "ApiKey" ADD COLUMN "rendersPerDay" INTEGER;
ALTER TABLE "ApiKey" ADD COLUMN "rendersPerMonth" INTEGER;
ALTER TABLE "ApiKey" ADD COLUMN "revokedAt" DATETIME;
ALTER TABLE "ApiKey" ADD COLUMN "rotatedAt" DATETIME;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "apiKeyId" TEXT;

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "response" TEXT,
    "createdAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,

    PRIMARY KEY ("workspaceId", "actorId", "key"),
    CONSTRAINT "IdempotencyKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "at" DATETIME NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "result" TEXT NOT NULL DEFAULT 'success',
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "data" TEXT,
    CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AuditLog" ("action", "actorId", "actorType", "at", "data", "id", "targetId", "targetType", "workspaceId") SELECT "action", "actorId", "actorType", "at", "data", "id", "targetId", "targetType", "workspaceId" FROM "AuditLog";
DROP TABLE "AuditLog";
ALTER TABLE "new_AuditLog" RENAME TO "AuditLog";
CREATE INDEX "AuditLog_workspaceId_at_idx" ON "AuditLog"("workspaceId", "at");
CREATE INDEX "AuditLog_workspaceId_action_at_idx" ON "AuditLog"("workspaceId", "action", "at");
CREATE INDEX "AuditLog_workspaceId_actorId_at_idx" ON "AuditLog"("workspaceId", "actorId", "at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "IdempotencyKey_workspaceId_expiresAt_idx" ON "IdempotencyKey"("workspaceId", "expiresAt");

-- CreateIndex
CREATE INDEX "ApiKey_prevPrefix_idx" ON "ApiKey"("prevPrefix");

-- CreateIndex
CREATE INDEX "Job_workspaceId_apiKeyId_createdAt_idx" ON "Job"("workspaceId", "apiKeyId", "createdAt");
