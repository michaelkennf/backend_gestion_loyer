"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
const pg_1 = require("pg");
const pool = new pg_1.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new adapter_pg_1.PrismaPg(pool);
const prisma = new client_1.PrismaClient({ adapter });
async function upsertUser(username, fullName, role, password) {
    const passwordHash = await bcryptjs_1.default.hash(password, 10);
    await prisma.user.upsert({
        where: { username },
        create: { username, fullName, role, passwordHash, forceReset: false },
        update: { fullName, role, passwordHash, forceReset: false },
    });
}
async function main() {
    await upsertUser("admin", "Administrateur", client_1.Role.ADMIN, "admin123");
    await upsertUser("manager", "Gestionnaire", client_1.Role.MANAGER, "manager123");
    await upsertUser("owner", "Proprietaire", client_1.Role.OWNER, "owner123");
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
