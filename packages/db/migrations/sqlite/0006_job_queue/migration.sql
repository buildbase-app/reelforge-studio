-- CreateTable
CREATE TABLE "RateLimitWindow" (
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "windowStart" DATETIME NOT NULL,
    "count" INTEGER NOT NULL,

    PRIMARY KEY ("workspaceId", "key", "windowStart"),
    CONSTRAINT "RateLimitWindow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "projectId" TEXT,
    "params" TEXT NOT NULL,
    "progress" TEXT NOT NULL,
    "result" TEXT,
    "error" TEXT,
    "retryOf" TEXT,
    "apiKeyId" TEXT,
    "createdAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "queue" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "workerId" TEXT,
    "leaseExpiresAt" DATETIME,
    "cancelRequestedAt" DATETIME,
    CONSTRAINT "Job_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Job" ("apiKeyId", "createdAt", "error", "finishedAt", "id", "params", "progress", "projectId", "result", "retryOf", "startedAt", "status", "type", "workspaceId") SELECT "apiKeyId", "createdAt", "error", "finishedAt", "id", "params", "progress", "projectId", "result", "retryOf", "startedAt", "status", "type", "workspaceId" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_workspaceId_createdAt_idx" ON "Job"("workspaceId", "createdAt");
CREATE INDEX "Job_workspaceId_projectId_idx" ON "Job"("workspaceId", "projectId");
CREATE INDEX "Job_status_idx" ON "Job"("status");
CREATE INDEX "Job_workspaceId_apiKeyId_createdAt_idx" ON "Job"("workspaceId", "apiKeyId", "createdAt");
CREATE INDEX "Job_workspaceId_queue_status_createdAt_idx" ON "Job"("workspaceId", "queue", "status", "createdAt");
CREATE INDEX "Job_status_leaseExpiresAt_idx" ON "Job"("status", "leaseExpiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "RateLimitWindow_windowStart_idx" ON "RateLimitWindow"("windowStart");
