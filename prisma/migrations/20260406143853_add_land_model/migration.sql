-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "landId" TEXT;

-- CreateTable
CREATE TABLE "Land" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "monthlyRent" DOUBLE PRECISION NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Land_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Land" ADD CONSTRAINT "Land_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_landId_fkey" FOREIGN KEY ("landId") REFERENCES "Land"("id") ON DELETE SET NULL ON UPDATE CASCADE;
