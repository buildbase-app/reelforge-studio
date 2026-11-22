-- AlterTable
ALTER TABLE "Project" ADD COLUMN "durationSeconds" REAL;
ALTER TABLE "Project" ADD COLUMN "sceneCount" INTEGER;

-- CreateIndex
CREATE INDEX "Project_workspaceId_createdAt_id_idx" ON "Project"("workspaceId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Job_workspaceId_createdAt_id_idx" ON "Job"("workspaceId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Job_workspaceId_projectId_createdAt_id_idx" ON "Job"("workspaceId", "projectId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Asset_workspaceId_createdAt_id_idx" ON "Asset"("workspaceId", "createdAt", "id");
