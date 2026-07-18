-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "activityDate" TIMESTAMP(3),
ADD COLUMN     "stageOverridden" BOOLEAN NOT NULL DEFAULT false;
