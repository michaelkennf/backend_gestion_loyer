-- CreateTable
CREATE TABLE "RentalDeposit" (
    "id" TEXT NOT NULL,
    "propertyUnitKey" TEXT NOT NULL,
    "tenantName" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL,
    "houseId" TEXT,
    "studioId" TEXT,
    "landId" TEXT,
    "floor" INTEGER,
    "apartmentNumber" INTEGER,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentalDeposit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RentalDeposit_propertyUnitKey_key" ON "RentalDeposit"("propertyUnitKey");

CREATE INDEX "RentalDeposit_houseId_idx" ON "RentalDeposit"("houseId");
CREATE INDEX "RentalDeposit_studioId_idx" ON "RentalDeposit"("studioId");
CREATE INDEX "RentalDeposit_landId_idx" ON "RentalDeposit"("landId");

ALTER TABLE "RentalDeposit" ADD CONSTRAINT "RentalDeposit_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "House"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RentalDeposit" ADD CONSTRAINT "RentalDeposit_studioId_fkey" FOREIGN KEY ("studioId") REFERENCES "Studio"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RentalDeposit" ADD CONSTRAINT "RentalDeposit_landId_fkey" FOREIGN KEY ("landId") REFERENCES "Land"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RentalDeposit" ADD CONSTRAINT "RentalDeposit_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
