import dotenv from "dotenv";
dotenv.config();
import path from "path";
import bcrypt from "bcryptjs";
import { PrismaClient, Role } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const dbFile = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.replace("file:", "")
  : path.resolve(process.cwd(), "locapro.db");
const DB_URL = `file:${path.resolve(dbFile).replace(/\\/g, "/")}`;
const adapter = new PrismaLibSql({ url: DB_URL });
const prisma = new PrismaClient({ adapter });

async function upsertUser(username: string, fullName: string, role: Role, password: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.upsert({
    where: { username },
    create: { username, fullName, role, passwordHash, forceReset: false },
    update: { fullName, role, passwordHash, forceReset: false },
  });
}

async function main() {
  await upsertUser("admin", "Administrateur", Role.ADMIN, "admin123");
  await upsertUser("manager", "Gestionnaire", Role.MANAGER, "manager123");
  await upsertUser("owner", "Proprietaire", Role.OWNER, "owner123");
  console.log("Seed terminee.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
