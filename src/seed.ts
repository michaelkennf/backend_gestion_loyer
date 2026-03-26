import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient, Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
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
