-- CreateTable
CREATE TABLE "InstanceLease" (
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "value" INTEGER,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("workspaceId", "name"),
    CONSTRAINT "InstanceLease_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
