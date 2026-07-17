-- CreateTable
CREATE TABLE "ScannedMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "threadRootId" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "fromEmail" TEXT NOT NULL DEFAULT '',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT '',
    "confidence" DOUBLE PRECISION,
    "reason" TEXT NOT NULL DEFAULT '',
    "lastError" TEXT NOT NULL DEFAULT '',
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScannedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScannedMessage_workspaceId_status_idx" ON "ScannedMessage"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScannedMessage_workspaceId_messageId_key" ON "ScannedMessage"("workspaceId", "messageId");

-- AddForeignKey
ALTER TABLE "ScannedMessage" ADD CONSTRAINT "ScannedMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
