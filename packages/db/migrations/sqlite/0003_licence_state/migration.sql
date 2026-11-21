-- CreateTable
CREATE TABLE "LicenceState" (
    "workspaceId" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "keyHash" TEXT,
    "answer" TEXT,
    "lastCheckedAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "lastError" TEXT,
    "activatedAt" DATETIME,
    "deactivatedAt" DATETIME,
    "nextCheckAt" DATETIME,
    "highWaterAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LicenceState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
