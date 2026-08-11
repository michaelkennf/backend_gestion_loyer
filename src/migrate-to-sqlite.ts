/**
 * migrate-to-sqlite.ts
 *
 * Exporte toutes les données du PostgreSQL de production vers
 * un fichier SQLite local (locapro.db), prêt à être bundlé dans le .exe.
 *
 * Usage:
 *   npx tsx src/migrate-to-sqlite.ts
 *
 * Variables requises dans .env (ou .env.production) :
 *   PROD_DATABASE_URL  → URL PostgreSQL de production
 *   DATABASE_URL       → URL SQLite cible (ex: file:./locapro.db)
 *
 * Le script :
 *  1. Se connecte au PostgreSQL via PROD_DATABASE_URL
 *  2. Lit toutes les tables dans l'ordre correct (FK)
 *  3. Insère tout dans le SQLite via Prisma (avec upsert pour idempotence)
 *  4. Copie les fichiers PDF de contrats si PROD_UPLOADS_DIR est défini
 */

import dotenv from "dotenv";
dotenv.config();

import path from "path";
import fs from "fs";
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

// ── Connexion PostgreSQL source ─────────────────────────────────────────────
const prodUrl = process.env.PROD_DATABASE_URL;
if (!prodUrl) {
  console.error("❌  PROD_DATABASE_URL manquant dans .env");
  process.exit(1);
}

const pgPool = new Pool({ connectionString: prodUrl, max: 5 });

// ── Client SQLite cible ─────────────────────────────────────────────────────
const dbFile = (process.env.DATABASE_URL ?? "file:./locapro.db").replace("file:", "");
const DB_URL = `file:${path.resolve(dbFile).replace(/\\/g, "/")}`;
const sqliteAdapter = new PrismaLibSql({ url: DB_URL });
const sqlite = new PrismaClient({ adapter: sqliteAdapter });

// ── Helpers ──────────────────────────────────────────────────────────────────
async function pgQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const client = await pgPool.connect();
  try {
    const res = await client.query(sql);
    return res.rows as T[];
  } finally {
    client.release();
  }
}

function log(msg: string) {
  console.log(`[migrate] ${msg}`);
}

// ── Migration ────────────────────────────────────────────────────────────────
async function main() {
  log(`Source PostgreSQL : ${prodUrl!.replace(/:[^:@]+@/, ":***@")}`);
  log(`Cible SQLite      : ${DB_URL}`);
  console.log();

  // 1. Users
  log("📦  Users…");
  const users = await pgQuery<{
    id: string; username: string; fullName: string; passwordHash: string;
    role: string; forceReset: boolean; createdAt: string; updatedAt: string;
  }>('SELECT * FROM "User"');
  for (const u of users) {
    await sqlite.user.upsert({
      where: { id: u.id },
      create: {
        id: u.id, username: u.username, fullName: u.fullName,
        passwordHash: u.passwordHash, role: u.role as any,
        forceReset: u.forceReset,
        createdAt: new Date(u.createdAt), updatedAt: new Date(u.updatedAt),
      },
      update: {
        username: u.username, fullName: u.fullName, passwordHash: u.passwordHash,
        role: u.role as any, forceReset: u.forceReset,
      },
    });
  }
  log(`   ✅  ${users.length} utilisateur(s)`);

  // 2. Suppliers
  log("📦  Fournisseurs…");
  const suppliers = await pgQuery<{
    id: string; name: string; contact: string; createdById: string;
    createdAt: string; updatedAt: string;
  }>('SELECT * FROM "Supplier"');
  for (const s of suppliers) {
    await sqlite.supplier.upsert({
      where: { id: s.id },
      create: {
        id: s.id, name: s.name, contact: s.contact, createdById: s.createdById,
        createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt),
      },
      update: { name: s.name, contact: s.contact },
    });
  }
  log(`   ✅  ${suppliers.length} fournisseur(s)`);

  // 3. Houses
  log("📦  Maisons / Immeubles…");
  const houses = await pgQuery<{
    id: string; address: string; floors: number; apartments: number;
    rentPrice: number; layout: unknown; isBuilding: boolean;
    createdById: string; createdAt: string; updatedAt: string;
  }>('SELECT * FROM "House"');
  for (const h of houses) {
    await sqlite.house.upsert({
      where: { id: h.id },
      create: {
        id: h.id, address: h.address, floors: h.floors, apartments: h.apartments,
        rentPrice: h.rentPrice, layout: h.layout as object ?? [],
        isBuilding: h.isBuilding, createdById: h.createdById,
        createdAt: new Date(h.createdAt), updatedAt: new Date(h.updatedAt),
      },
      update: {
        address: h.address, floors: h.floors, apartments: h.apartments,
        rentPrice: h.rentPrice, layout: h.layout as object ?? [],
        isBuilding: h.isBuilding,
      },
    });
  }
  log(`   ✅  ${houses.length} maison(s)/immeuble(s)`);

  // 4. Studios
  log("📦  Studios…");
  const studios = await pgQuery<{
    id: string; address: string; monthlyRent: number;
    createdById: string; createdAt: string; updatedAt: string;
  }>('SELECT * FROM "Studio"');
  for (const s of studios) {
    await sqlite.studio.upsert({
      where: { id: s.id },
      create: {
        id: s.id, address: s.address, monthlyRent: s.monthlyRent,
        createdById: s.createdById,
        createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt),
      },
      update: { address: s.address, monthlyRent: s.monthlyRent },
    });
  }
  log(`   ✅  ${studios.length} studio(s)`);

  // 5. Lands
  log("📦  Terrains…");
  const lands = await pgQuery<{
    id: string; address: string; size: number; monthlyRent: number;
    createdById: string; createdAt: string; updatedAt: string;
  }>('SELECT * FROM "Land"');
  for (const l of lands) {
    await sqlite.land.upsert({
      where: { id: l.id },
      create: {
        id: l.id, address: l.address, size: l.size, monthlyRent: l.monthlyRent,
        createdById: l.createdById,
        createdAt: new Date(l.createdAt), updatedAt: new Date(l.updatedAt),
      },
      update: { address: l.address, size: l.size, monthlyRent: l.monthlyRent },
    });
  }
  log(`   ✅  ${lands.length} terrain(s)`);

  // 6. Payments
  log("📦  Paiements…");
  const payments = await pgQuery<{
    id: string; propertyType: string; paymentKind: string; tenantName: string | null;
    contractFilePath: string | null; month: string; monthsCount: number | null;
    amount: number; expectedAmount: number | null; notes: string | null;
    floor: number | null; apartmentNumber: number | null; date: string;
    createdById: string; houseId: string | null; studioId: string | null;
    landId: string | null; createdAt: string;
  }>('SELECT * FROM "Payment" ORDER BY "createdAt" ASC');
  for (const p of payments) {
    await sqlite.payment.upsert({
      where: { id: p.id },
      create: {
        id: p.id, propertyType: p.propertyType as any, paymentKind: p.paymentKind as any,
        tenantName: p.tenantName, contractFilePath: p.contractFilePath,
        month: p.month, monthsCount: p.monthsCount, amount: p.amount,
        expectedAmount: p.expectedAmount, notes: p.notes,
        floor: p.floor, apartmentNumber: p.apartmentNumber,
        date: new Date(p.date), createdById: p.createdById,
        houseId: p.houseId, studioId: p.studioId, landId: p.landId,
        createdAt: new Date(p.createdAt),
      },
      update: {
        amount: p.amount, expectedAmount: p.expectedAmount, notes: p.notes,
        month: p.month, monthsCount: p.monthsCount,
        contractFilePath: p.contractFilePath,
      },
    });
  }
  log(`   ✅  ${payments.length} paiement(s)`);

  // 7. Expenses
  log("📦  Dépenses…");
  const expenses = await pgQuery<{
    id: string; expenseType: string; propertyType: string; apartmentNumber: string | null;
    category: string; amount: number; comment: string | null; date: string;
    createdById: string; houseId: string | null; studioId: string | null;
    landId: string | null; supplierId: string | null; createdAt: string;
  }>('SELECT * FROM "Expense" ORDER BY "createdAt" ASC');
  for (const e of expenses) {
    await sqlite.expense.upsert({
      where: { id: e.id },
      create: {
        id: e.id, expenseType: e.expenseType as any, propertyType: e.propertyType as any,
        apartmentNumber: e.apartmentNumber, category: e.category,
        amount: e.amount, comment: e.comment, date: new Date(e.date),
        createdById: e.createdById, houseId: e.houseId, studioId: e.studioId,
        landId: e.landId, supplierId: e.supplierId,
        createdAt: new Date(e.createdAt),
      },
      update: { amount: e.amount, category: e.category, comment: e.comment },
    });
  }
  log(`   ✅  ${expenses.length} dépense(s)`);

  // 8. Comments
  log("📦  Commentaires…");
  const comments = await pgQuery<{
    id: string; content: string; paymentId: string | null; expenseId: string | null;
    createdById: string; createdAt: string;
  }>('SELECT * FROM "Comment" ORDER BY "createdAt" ASC');
  for (const c of comments) {
    await sqlite.comment.upsert({
      where: { id: c.id },
      create: {
        id: c.id, content: c.content, paymentId: c.paymentId,
        expenseId: c.expenseId, createdById: c.createdById,
        createdAt: new Date(c.createdAt),
      },
      update: { content: c.content },
    });
  }
  log(`   ✅  ${comments.length} commentaire(s)`);

  // 9. RentalDeposits
  log("📦  Garanties locatives…");
  const deposits = await pgQuery<{
    id: string; propertyUnitKey: string; tenantName: string; balance: number;
    houseId: string | null; studioId: string | null; landId: string | null;
    floor: number | null; apartmentNumber: number | null; notes: string | null;
    createdById: string; createdAt: string; updatedAt: string;
  }>('SELECT * FROM "RentalDeposit"');
  for (const d of deposits) {
    await sqlite.rentalDeposit.upsert({
      where: { id: d.id },
      create: {
        id: d.id, propertyUnitKey: d.propertyUnitKey, tenantName: d.tenantName,
        balance: d.balance, houseId: d.houseId, studioId: d.studioId,
        landId: d.landId, floor: d.floor, apartmentNumber: d.apartmentNumber,
        notes: d.notes, createdById: d.createdById,
        createdAt: new Date(d.createdAt), updatedAt: new Date(d.updatedAt),
      },
      update: { balance: d.balance, tenantName: d.tenantName, notes: d.notes },
    });
  }
  log(`   ✅  ${deposits.length} garantie(s)`);

  // 10. RentalDepositTransactions
  log("📦  Transactions de garanties…");
  const txs = await pgQuery<{
    id: string; rentalDepositId: string; type: string; amount: number;
    comment: string | null; createdById: string; createdAt: string;
  }>('SELECT * FROM "RentalDepositTransaction" ORDER BY "createdAt" ASC');
  for (const t of txs) {
    await sqlite.rentalDepositTransaction.upsert({
      where: { id: t.id },
      create: {
        id: t.id, rentalDepositId: t.rentalDepositId, type: t.type as any,
        amount: t.amount, comment: t.comment, createdById: t.createdById,
        createdAt: new Date(t.createdAt),
      },
      update: { amount: t.amount, comment: t.comment },
    });
  }
  log(`   ✅  ${txs.length} transaction(s) de garantie`);

  // 11. Copie des PDFs de contrats
  const prodUploadsDir = process.env.PROD_UPLOADS_DIR;
  if (prodUploadsDir) {
    log("📎  Copie des PDFs de contrats…");
    const localUploads = path.resolve(process.cwd(), "uploads", "contracts");
    fs.mkdirSync(localUploads, { recursive: true });
    if (fs.existsSync(prodUploadsDir)) {
      const files = fs.readdirSync(prodUploadsDir);
      let copied = 0;
      for (const f of files) {
        const src = path.join(prodUploadsDir, f);
        const dest = path.join(localUploads, f);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
          copied++;
        }
      }
      log(`   ✅  ${copied} PDF(s) copiés (${files.length - copied} déjà présents)`);
    } else {
      log(`   ⚠️  Dossier source introuvable : ${prodUploadsDir}`);
    }
  } else {
    log("ℹ️  PROD_UPLOADS_DIR non défini → PDFs ignorés");
  }

  console.log();
  log("✅  Migration terminée. Fichier SQLite prêt : " + DB_URL);
}

main()
  .catch((e) => { console.error("❌  Erreur :", e.message); process.exit(1); })
  .finally(async () => {
    await sqlite.$disconnect();
    await pgPool.end();
  });
