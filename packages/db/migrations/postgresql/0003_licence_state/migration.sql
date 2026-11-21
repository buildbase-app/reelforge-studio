-- CreateTable
CREATE TABLE "LicenceState" (
    "workspaceId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "keyHash" TEXT,
    "answer" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "activatedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "highWaterAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LicenceState_pkey" PRIMARY KEY ("workspaceId")
);

-- AddForeignKey
ALTER TABLE "LicenceState" ADD CONSTRAINT "LicenceState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
