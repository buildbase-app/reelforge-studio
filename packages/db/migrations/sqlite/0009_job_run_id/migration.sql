-- AlterTable
ALTER TABLE "Job" ADD COLUMN "runId" TEXT;

-- Backfill (#184): render and preview jobs written before this migration get their run id from params.
UPDATE "Job" SET "runId" = json_extract("params", '$.runId') WHERE "type" IN ('render', 'preview') AND "runId" IS NULL;

-- CreateIndex
CREATE INDEX "Job_workspaceId_runId_idx" ON "Job"("workspaceId", "runId");
