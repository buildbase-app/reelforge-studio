-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex
CREATE INDEX "WebhookDelivery_workspaceId_eventId_idx" ON "WebhookDelivery"("workspaceId", "eventId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_workspaceId_dedupeKey_idx" ON "WebhookDelivery"("workspaceId", "dedupeKey");
