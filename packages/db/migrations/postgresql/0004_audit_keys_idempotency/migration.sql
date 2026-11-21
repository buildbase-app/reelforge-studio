-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "ipAllowlist" TEXT,
ADD COLUMN     "prevExpiresAt" TIMESTAMP(3),
ADD COLUMN     "prevHash" TEXT,
ADD COLUMN     "prevPrefix" TEXT,
ADD COLUMN     "prevSalt" TEXT,
ADD COLUMN     "rateLimitPerMinute" INTEGER,
ADD COLUMN     "rendersPerDay" INTEGER,
ADD COLUMN     "rendersPerMonth" INTEGER,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "rotatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "apiKeyId" TEXT;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorName" TEXT,
ADD COLUMN     "ip" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "result" TEXT NOT NULL DEFAULT 'success',
ADD COLUMN     "userAgent" TEXT;

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("workspaceId","actorId","key")
);

-- CreateIndex
CREATE INDEX "IdempotencyKey_workspaceId_expiresAt_idx" ON "IdempotencyKey"("workspaceId", "expiresAt");

-- CreateIndex
CREATE INDEX "ApiKey_prevPrefix_idx" ON "ApiKey"("prevPrefix");

-- CreateIndex
CREATE INDEX "Job_workspaceId_apiKeyId_createdAt_idx" ON "Job"("workspaceId", "apiKeyId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_action_at_idx" ON "AuditLog"("workspaceId", "action", "at");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_actorId_at_idx" ON "AuditLog"("workspaceId", "actorId", "at");

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
