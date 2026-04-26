-- CreateTable
CREATE TABLE "IdempotencyKey" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "responseStatus" INTEGER NOT NULL,
  "responseBody" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_key_key" ON "IdempotencyKey"("key");

-- CreateIndex
CREATE INDEX "IdempotencyKey_userId_createdAt_idx" ON "IdempotencyKey"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "IdempotencyKey"
ADD CONSTRAINT "IdempotencyKey_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
