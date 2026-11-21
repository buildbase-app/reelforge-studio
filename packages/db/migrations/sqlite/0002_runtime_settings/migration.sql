-- CreateTable
CREATE TABLE "Setting" (
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "scheme" TEXT NOT NULL DEFAULT 'plain',
    "updatedAt" DATETIME NOT NULL,
    "updatedBy" TEXT,

    PRIMARY KEY ("workspaceId", "key"),
    CONSTRAINT "Setting_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
