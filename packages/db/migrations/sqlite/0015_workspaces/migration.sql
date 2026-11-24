-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "updatedAt" DATETIME,
    "suspendedAt" DATETIME,
    "deletedAt" DATETIME,
    "purgeAfter" DATETIME,
    "limits" TEXT
);
INSERT INTO "new_Workspace" ("createdAt", "id", "name") SELECT "createdAt", "id", "name" FROM "Workspace";
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Data (#304): admin keys made before workspaces ran the whole install; they keep that power as the new
-- instance-level "owner" scope. Admin keys made from now on manage only their own workspace.
UPDATE "ApiKey" SET "scopes" = REPLACE("scopes", '"admin"', '"admin","owner"') WHERE "scopes" LIKE '%"admin"%' AND "scopes" NOT LIKE '%"owner"%';
