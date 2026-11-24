-- CreateIndex
CREATE INDEX "Job_claim_idx" ON "Job"("workspaceId", "queue", "status", "apiKeyId", "priority", "createdAt");
