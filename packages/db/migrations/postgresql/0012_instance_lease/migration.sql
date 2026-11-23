-- CreateTable
CREATE TABLE "InstanceLease" (
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "value" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstanceLease_pkey" PRIMARY KEY ("workspaceId","name")
);

-- AddForeignKey
ALTER TABLE "InstanceLease" ADD CONSTRAINT "InstanceLease_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
