-- AlterTable
ALTER TABLE "Job" ADD COLUMN "parentId" TEXT;
ALTER TABLE "Job" ADD COLUMN "pendingChildren" INTEGER;

-- CreateIndex
CREATE INDEX "Job_parentId_idx" ON "Job"("parentId");
