-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "url" TEXT,
    "urlScheme" TEXT,
    "urlDisplay" TEXT,
    "email" TEXT,
    "events" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledReason" TEXT,
    "secret" TEXT,
    "secretScheme" TEXT,
    "prevSecret" TEXT,
    "prevSecretScheme" TEXT,
    "prevSecretExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT,
    CONSTRAINT "WebhookEndpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL,
    "lockedUntil" DATETIME,
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "deliveredAt" DATETIME,
    "replayOf" TEXT,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WebhookDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "at" DATETIME NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "status" INTEGER,
    "error" TEXT,
    "outcome" TEXT NOT NULL,
    CONSTRAINT "WebhookAttempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WebhookEndpoint_workspaceId_createdAt_idx" ON "WebhookEndpoint"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_workspaceId_status_nextAttemptAt_idx" ON "WebhookDelivery"("workspaceId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_workspaceId_endpointId_id_idx" ON "WebhookDelivery"("workspaceId", "endpointId", "id");

-- CreateIndex
CREATE INDEX "WebhookDelivery_workspaceId_status_updatedAt_idx" ON "WebhookDelivery"("workspaceId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "WebhookAttempt_workspaceId_deliveryId_idx" ON "WebhookAttempt"("workspaceId", "deliveryId");
