-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('RENTAL_RENT', 'MONTHLY_PAYMENT');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "contractFilePath" TEXT,
ADD COLUMN     "monthsCount" INTEGER,
ADD COLUMN     "paymentKind" "PaymentKind" NOT NULL DEFAULT 'MONTHLY_PAYMENT',
ADD COLUMN     "tenantName" TEXT;
