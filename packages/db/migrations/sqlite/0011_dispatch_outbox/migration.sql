-- CreateTable
CREATE TABLE "DispatchOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL,
    "lockedUntil" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "DispatchOutbox_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DispatchOutbox_workspaceId_nextAttemptAt_idx" ON "DispatchOutbox"("workspaceId", "nextAttemptAt");
