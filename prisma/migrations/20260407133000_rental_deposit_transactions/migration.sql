-- CreateEnum
CREATE TYPE "RentalDepositTransactionType" AS ENUM ('EXPENSE', 'REFUND');

-- CreateTable
CREATE TABLE "RentalDepositTransaction" (
  "id" TEXT NOT NULL,
  "rentalDepositId" TEXT NOT NULL,
  "type" "RentalDepositTransactionType" NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "comment" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RentalDepositTransaction_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "RentalDepositTransaction_rentalDepositId_idx" ON "RentalDepositTransaction"("rentalDepositId");
CREATE INDEX "RentalDepositTransaction_createdAt_idx" ON "RentalDepositTransaction"("createdAt");

-- FKs
ALTER TABLE "RentalDepositTransaction" ADD CONSTRAINT "RentalDepositTransaction_rentalDepositId_fkey"
  FOREIGN KEY ("rentalDepositId") REFERENCES "RentalDeposit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RentalDepositTransaction" ADD CONSTRAINT "RentalDepositTransaction_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

