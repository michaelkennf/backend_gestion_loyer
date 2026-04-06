-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "landId" TEXT;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_landId_fkey" FOREIGN KEY ("landId") REFERENCES "Land"("id") ON DELETE SET NULL ON UPDATE CASCADE;
