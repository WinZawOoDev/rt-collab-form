-- AlterTable
ALTER TABLE "Post" ALTER COLUMN "title" SET DEFAULT '';

-- DropTable
DROP TABLE "EvaluateDraft";

-- CreateTable
CREATE TABLE "TeamDraft" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamDraft_pkey" PRIMARY KEY ("id")
);
