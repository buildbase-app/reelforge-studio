-- CreateTable
CREATE TABLE "DispatchOutbox" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DispatchOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DispatchOutbox_workspaceId_nextAttemptAt_idx" ON "DispatchOutbox"("workspaceId", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "DispatchOutbox" ADD CONSTRAINT "DispatchOutbox_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
