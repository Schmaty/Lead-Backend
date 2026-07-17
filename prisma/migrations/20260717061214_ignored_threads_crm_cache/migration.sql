-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "crmCheckedAt" TIMESTAMP(3),
ADD COLUMN     "crmRecords" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "IgnoredThread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "fromAddress" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IgnoredThread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IgnoredThread_workspaceId_threadKey_key" ON "IgnoredThread"("workspaceId", "threadKey");

-- AddForeignKey
ALTER TABLE "IgnoredThread" ADD CONSTRAINT "IgnoredThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
