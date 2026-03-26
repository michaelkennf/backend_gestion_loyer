"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const crypto_1 = require("crypto");
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
const pg_1 = require("pg");
const zod_1 = require("zod");
const app = (0, express_1.default)();
const pool = new pg_1.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new adapter_pg_1.PrismaPg(pool);
const prisma = new client_1.PrismaClient({ adapter });
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "dev-refresh-secret";
const PORT = Number(process.env.PORT || 4000);
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({ origin: process.env.CORS_ORIGIN || "http://localhost:3000" }));
app.use(express_1.default.json());
app.use((0, morgan_1.default)("dev"));
app.use((0, express_rate_limit_1.default)({ windowMs: 15 * 60 * 1000, max: 300 }));
function signToken(user) {
    return jsonwebtoken_1.default.sign(user, JWT_SECRET, { expiresIn: "8h" });
}
function signRefreshToken(user) {
    return jsonwebtoken_1.default.sign(user, JWT_REFRESH_SECRET, { expiresIn: "7d" });
}
function money(value) {
    return Number(value.toFixed(2));
}
function auth(req, res, next) {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token)
        return res.status(401).json({ message: "Token manquant" });
    try {
        req.user = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        next();
    }
    catch {
        return res.status(401).json({ message: "Token invalide" });
    }
}
async function propertyExists(propertyType, propertyId) {
    if (propertyType === "house") {
        const house = await prisma.house.findUnique({ where: { id: propertyId }, select: { id: true } });
        return Boolean(house);
    }
    const studio = await prisma.studio.findUnique({ where: { id: propertyId }, select: { id: true } });
    return Boolean(studio);
}
async function getHouseByIdWithLayout(id) {
    const rows = await prisma.$queryRaw `
    SELECT "id","address","floors","apartments","rentPrice","createdById","createdAt","updatedAt","layout"
    FROM "House"
    WHERE "id" = ${id}
    LIMIT 1
  `;
    return rows[0] ?? null;
}
async function listHousesWithLayout() {
    return prisma.$queryRaw `
    SELECT "id","address","floors","apartments","rentPrice","createdById","createdAt","updatedAt","layout"
    FROM "House"
    ORDER BY "createdAt" DESC
  `;
}
async function updateHouseWithLayout(id, data) {
    await prisma.$executeRaw `
    UPDATE "House"
    SET "address" = ${data.address},
        "floors" = ${data.floors},
        "apartments" = ${data.apartments},
        "rentPrice" = ${data.rentPrice},
        "layout" = ${JSON.stringify(data.layout)}::jsonb,
        "updatedAt" = NOW()
    WHERE "id" = ${id}
  `;
}
async function deleteHouseById(id) {
    await prisma.$executeRaw `DELETE FROM "House" WHERE "id" = ${id}`;
}
function allow(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role))
            return res.status(403).json({ message: "Accès refusé" });
        next();
    };
}
async function createRefreshTokenRecord(userId, tokenHash, expiresAt) {
    const id = (0, crypto_1.randomUUID)();
    await prisma.$executeRaw `
    INSERT INTO "RefreshToken" ("id", "tokenHash", "userId", "expiresAt", "createdAt")
    VALUES (${id}, ${tokenHash}, ${userId}, ${expiresAt}, NOW())
  `;
}
async function findRefreshTokensByUser(userId, limit) {
    return prisma.$queryRaw `
    SELECT "id", "tokenHash", "userId", "expiresAt", "createdAt"
    FROM "RefreshToken"
    WHERE "userId" = ${userId} AND "expiresAt" > NOW()
    ORDER BY "createdAt" DESC
    LIMIT ${limit}
  `;
}
async function deleteRefreshTokenById(id) {
    await prisma.$executeRaw `DELETE FROM "RefreshToken" WHERE "id" = ${id}`;
}
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.post("/api/auth/login", async (req, res) => {
    const schema = zod_1.z.object({ username: zod_1.z.string().min(1), password: zod_1.z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const user = await prisma.user.findUnique({ where: { username: parsed.data.username } });
    if (!user)
        return res.status(401).json({ message: "Identifiants invalides" });
    const ok = await bcryptjs_1.default.compare(parsed.data.password, user.passwordHash);
    if (!ok)
        return res.status(401).json({ message: "Identifiants invalides" });
    const payload = { id: user.id, role: user.role, username: user.username };
    const token = signToken(payload);
    const refreshToken = signRefreshToken(payload);
    const tokenHash = await bcryptjs_1.default.hash(refreshToken, 10);
    await createRefreshTokenRecord(user.id, tokenHash, new Date(Date.now() + 7 * 24 * 3600 * 1000));
    return res.json({
        token,
        refreshToken,
        user: { id: user.id, username: user.username, fullName: user.fullName, role: user.role, forceReset: user.forceReset },
    });
});
app.post("/api/auth/refresh", async (req, res) => {
    const schema = zod_1.z.object({ refreshToken: zod_1.z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    let decoded;
    try {
        decoded = jsonwebtoken_1.default.verify(parsed.data.refreshToken, JWT_REFRESH_SECRET);
    }
    catch {
        return res.status(401).json({ message: "Refresh token invalide" });
    }
    if (typeof decoded === "string")
        return res.status(401).json({ message: "Refresh token invalide" });
    const payload = {
        id: String(decoded.id),
        role: decoded.role,
        username: String(decoded.username),
    };
    if (!payload.id || !payload.role || !payload.username) {
        return res.status(401).json({ message: "Refresh token invalide" });
    }
    const candidates = await findRefreshTokensByUser(payload.id, 30);
    let matchedTokenId = null;
    for (const item of candidates) {
        const ok = await bcryptjs_1.default.compare(parsed.data.refreshToken, item.tokenHash);
        if (ok) {
            matchedTokenId = item.id;
            break;
        }
    }
    if (!matchedTokenId)
        return res.status(401).json({ message: "Refresh token invalide" });
    const token = signToken(payload);
    const nextRefreshToken = signRefreshToken(payload);
    const nextTokenHash = await bcryptjs_1.default.hash(nextRefreshToken, 10);
    await deleteRefreshTokenById(matchedTokenId);
    await createRefreshTokenRecord(payload.id, nextTokenHash, new Date(Date.now() + 7 * 24 * 3600 * 1000));
    return res.json({ token, refreshToken: nextRefreshToken });
});
app.post("/api/auth/logout", async (req, res) => {
    const schema = zod_1.z.object({ refreshToken: zod_1.z.string().optional() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    if (!parsed.data.refreshToken)
        return res.json({ message: "OK" });
    let payload;
    try {
        payload = jsonwebtoken_1.default.verify(parsed.data.refreshToken, JWT_REFRESH_SECRET);
    }
    catch {
        return res.json({ message: "OK" });
    }
    const rows = await findRefreshTokensByUser(payload.id, 50);
    for (const row of rows) {
        const ok = await bcryptjs_1.default.compare(parsed.data.refreshToken, row.tokenHash);
        if (ok) {
            await deleteRefreshTokenById(row.id);
            break;
        }
    }
    return res.json({ message: "OK" });
});
app.get("/api/auth/me", auth, async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user)
        return res.status(404).json({ message: "Utilisateur introuvable" });
    return res.json({ id: user.id, username: user.username, fullName: user.fullName, role: user.role, forceReset: user.forceReset });
});
app.post("/api/auth/change-password", auth, async (req, res) => {
    const schema = zod_1.z.object({
        currentPassword: zod_1.z.string().min(1),
        newPassword: zod_1.z.string().min(6),
        confirmPassword: zod_1.z.string().min(6),
    }).refine((v) => v.newPassword === v.confirmPassword, { message: "Confirmation invalide", path: ["confirmPassword"] });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user)
        return res.status(404).json({ message: "Utilisateur introuvable" });
    const ok = await bcryptjs_1.default.compare(parsed.data.currentPassword, user.passwordHash);
    if (!ok)
        return res.status(400).json({ message: "Mot de passe actuel incorrect" });
    const hash = await bcryptjs_1.default.hash(parsed.data.newPassword, 10);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash, forceReset: false } });
    return res.json({ message: "Mot de passe modifié" });
});
app.get("/api/users", auth, allow(client_1.Role.ADMIN), async (_req, res) => {
    const users = await prisma.user.findMany({ select: { id: true, username: true, fullName: true, role: true, forceReset: true, createdAt: true } });
    return res.json(users);
});
app.post("/api/users", auth, allow(client_1.Role.ADMIN), async (req, res) => {
    const schema = zod_1.z.object({
        username: zod_1.z.string().min(3),
        fullName: zod_1.z.string().min(3),
        role: zod_1.z.enum([client_1.Role.ADMIN, client_1.Role.MANAGER, client_1.Role.OWNER]),
        password: zod_1.z.string().min(6),
        forceReset: zod_1.z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const hash = await bcryptjs_1.default.hash(parsed.data.password, 10);
    const user = await prisma.user.create({
        data: { ...parsed.data, passwordHash: hash, forceReset: parsed.data.forceReset ?? true },
        select: { id: true, username: true, fullName: true, role: true, forceReset: true },
    });
    return res.status(201).json(user);
});
app.post("/api/users/:id/reset-password", auth, allow(client_1.Role.ADMIN), async (req, res) => {
    const schema = zod_1.z.object({ newPassword: zod_1.z.string().min(6) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const hash = await bcryptjs_1.default.hash(parsed.data.newPassword, 10);
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await prisma.user.update({ where: { id }, data: { passwordHash: hash, forceReset: true } });
    return res.json({ message: "Mot de passe réinitialisé" });
});
app.get("/api/properties", auth, async (_req, res) => {
    const [houses, studios] = await Promise.all([listHousesWithLayout(), prisma.studio.findMany({ orderBy: { createdAt: "desc" } })]);
    res.json({ houses, studios });
});
app.post("/api/properties/houses", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        address: zod_1.z.string().min(3),
        levels: zod_1.z.array(zod_1.z.object({
            floor: zod_1.z.number().int().min(1),
            apartments: zod_1.z.array(zod_1.z.object({
                number: zod_1.z.number().int().min(1),
                rentPrice: zod_1.z.number().positive(),
            })).min(1),
        })).min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const levels = parsed.data.levels.map((lvl) => ({
        floor: lvl.floor,
        apartments: lvl.apartments.map((apt) => ({ number: apt.number, rentPrice: money(apt.rentPrice) })),
    }));
    const floors = levels.length;
    const apartments = levels.reduce((sum, lvl) => sum + lvl.apartments.length, 0);
    const totalRent = levels.reduce((sum, lvl) => sum + lvl.apartments.reduce((s, apt) => s + apt.rentPrice, 0), 0);
    const rentPrice = apartments > 0 ? money(totalRent / apartments) : 0;
    const house = await prisma.house.create({
        data: {
            address: parsed.data.address,
            floors,
            apartments,
            rentPrice,
            layout: levels,
            createdById: req.user.id,
        },
    });
    res.status(201).json(house);
});
app.post("/api/properties/studios", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({ address: zod_1.z.string().min(3), monthlyRent: zod_1.z.number().positive() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const studio = await prisma.studio.create({
        data: { ...parsed.data, monthlyRent: money(parsed.data.monthlyRent), createdById: req.user.id },
    });
    res.status(201).json(studio);
});
app.put("/api/properties/houses/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        address: zod_1.z.string().min(3),
        levels: zod_1.z.array(zod_1.z.object({
            floor: zod_1.z.number().int().min(1),
            apartments: zod_1.z.array(zod_1.z.object({ number: zod_1.z.number().int().min(1), rentPrice: zod_1.z.number().positive() })).min(1),
        })).min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const house = await getHouseByIdWithLayout(id);
    if (!house)
        return res.status(404).json({ message: "Maison introuvable" });
    const levels = parsed.data.levels.map((lvl) => ({
        floor: lvl.floor,
        apartments: lvl.apartments.map((apt) => ({ number: apt.number, rentPrice: money(apt.rentPrice) })),
    }));
    const floors = levels.length;
    const apartments = levels.reduce((sum, lvl) => sum + lvl.apartments.length, 0);
    const totalRent = levels.reduce((sum, lvl) => sum + lvl.apartments.reduce((s, apt) => s + apt.rentPrice, 0), 0);
    const rentPrice = apartments > 0 ? money(totalRent / apartments) : 0;
    await updateHouseWithLayout(id, {
        address: parsed.data.address,
        floors,
        apartments,
        rentPrice,
        layout: levels,
    });
    const updated = await getHouseByIdWithLayout(id);
    res.json(updated);
});
app.delete("/api/properties/houses/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const house = await getHouseByIdWithLayout(id);
    if (!house)
        return res.status(404).json({ message: "Maison introuvable" });
    await deleteHouseById(id);
    res.json({ message: "Maison supprimée" });
});
app.put("/api/properties/studios/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({ address: zod_1.z.string().min(3), monthlyRent: zod_1.z.number().positive() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const studio = await prisma.studio.findUnique({ where: { id } });
    if (!studio)
        return res.status(404).json({ message: "Studio introuvable" });
    const updated = await prisma.studio.update({
        where: { id },
        data: { address: parsed.data.address, monthlyRent: money(parsed.data.monthlyRent) },
    });
    res.json(updated);
});
app.delete("/api/properties/studios/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const studio = await prisma.studio.findUnique({ where: { id } });
    if (!studio)
        return res.status(404).json({ message: "Studio introuvable" });
    await prisma.studio.delete({ where: { id } });
    res.json({ message: "Studio supprimé" });
});
app.post("/api/payments", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        propertyType: zod_1.z.enum(["house", "studio"]),
        propertyId: zod_1.z.string().min(1),
        month: zod_1.z.string().regex(/^\d{4}-\d{2}$/),
        amount: zod_1.z.number().positive(),
        notes: zod_1.z.string().optional(),
        floor: zod_1.z.number().int().min(1).optional(),
        apartmentNumber: zod_1.z.number().int().min(1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    if (parsed.data.propertyType === "house") {
        const house = await getHouseByIdWithLayout(parsed.data.propertyId);
        if (!house)
            return res.status(404).json({ message: "Propriete introuvable" });
        if (!parsed.data.floor || !parsed.data.apartmentNumber) {
            return res.status(400).json({ message: "Niveau et appartement sont requis pour une maison" });
        }
        const layout = house.layout;
        const level = layout.find((l) => l.floor === parsed.data.floor);
        if (!level)
            return res.status(400).json({ message: "Niveau invalide" });
        const apartment = level.apartments.find((a) => a.number === parsed.data.apartmentNumber);
        if (!apartment)
            return res.status(400).json({ message: "Appartement invalide pour ce niveau" });
    }
    else {
        const exists = await propertyExists(parsed.data.propertyType, parsed.data.propertyId);
        if (!exists)
            return res.status(404).json({ message: "Propriete introuvable" });
    }
    const isHouse = parsed.data.propertyType === "house";
    const floor = parsed.data.floor ?? null;
    const apartmentNumber = parsed.data.apartmentNumber ?? null;
    let amount = money(parsed.data.amount);
    if (isHouse) {
        const house = await getHouseByIdWithLayout(parsed.data.propertyId);
        const layout = (house?.layout ?? []);
        const level = layout.find((l) => l.floor === floor);
        const apartment = level?.apartments.find((a) => a.number === apartmentNumber);
        if (!apartment)
            return res.status(400).json({ message: "Appartement introuvable" });
        amount = money(apartment.rentPrice);
    }
    const payment = await prisma.payment.create({
        data: {
            propertyType: isHouse ? client_1.PropertyType.HOUSE : client_1.PropertyType.STUDIO,
            houseId: isHouse ? parsed.data.propertyId : null,
            studioId: isHouse ? null : parsed.data.propertyId,
            month: parsed.data.month,
            amount: money(amount),
            notes: parsed.data.notes,
            ...(floor !== null ? { floor } : {}),
            ...(apartmentNumber !== null ? { apartmentNumber } : {}),
            date: new Date(),
            createdById: req.user.id,
        },
    });
    res.status(201).json(payment);
});
app.post("/api/expenses", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        expenseType: zod_1.z.enum(["common", "private"]),
        propertyType: zod_1.z.enum(["house", "studio"]),
        propertyId: zod_1.z.string().min(1),
        apartmentNumber: zod_1.z.string().optional(),
        category: zod_1.z.string().min(1),
        amount: zod_1.z.number().positive(),
        comment: zod_1.z.string().optional(),
        date: zod_1.z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    if (parsed.data.expenseType === "private" && !parsed.data.apartmentNumber?.trim()) {
        return res.status(400).json({ message: "Appartement requis pour une depense privee" });
    }
    const exists = await propertyExists(parsed.data.propertyType, parsed.data.propertyId);
    if (!exists)
        return res.status(404).json({ message: "Propriete introuvable" });
    const isHouse = parsed.data.propertyType === "house";
    const expense = await prisma.expense.create({
        data: {
            expenseType: parsed.data.expenseType === "common" ? client_1.ExpenseType.COMMON : client_1.ExpenseType.PRIVATE,
            propertyType: isHouse ? client_1.PropertyType.HOUSE : client_1.PropertyType.STUDIO,
            houseId: isHouse ? parsed.data.propertyId : null,
            studioId: isHouse ? null : parsed.data.propertyId,
            apartmentNumber: parsed.data.apartmentNumber,
            category: parsed.data.category,
            amount: money(parsed.data.amount),
            comment: parsed.data.comment,
            date: new Date(parsed.data.date),
            createdById: req.user.id,
        },
    });
    res.status(201).json(expense);
});
app.put("/api/payments/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        month: zod_1.z.string().regex(/^\d{4}-\d{2}$/),
        notes: zod_1.z.string().optional(),
        floor: zod_1.z.number().int().min(1).optional(),
        apartmentNumber: zod_1.z.number().int().min(1).optional(),
        amount: zod_1.z.number().positive().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const existing = await prisma.payment.findUnique({ where: { id } });
    if (!existing)
        return res.status(404).json({ message: "Paiement introuvable" });
    const existingFloor = existing.floor ?? null;
    const existingApartmentNumber = existing.apartmentNumber ?? null;
    let amount = parsed.data.amount ? money(parsed.data.amount) : money(existing.amount);
    let floor = parsed.data.floor ?? existingFloor;
    let apartmentNumber = parsed.data.apartmentNumber ?? existingApartmentNumber;
    if (existing.propertyType === client_1.PropertyType.HOUSE) {
        if (!floor || !apartmentNumber) {
            return res.status(400).json({ message: "Niveau et appartement requis pour un paiement maison" });
        }
        const house = await getHouseByIdWithLayout(existing.houseId ?? "");
        if (!house)
            return res.status(404).json({ message: "Maison introuvable" });
        const layout = (house.layout ?? []);
        const level = layout.find((l) => l.floor === floor);
        const apartment = level?.apartments.find((a) => a.number === apartmentNumber);
        if (!apartment)
            return res.status(400).json({ message: "Appartement invalide" });
        amount = money(apartment.rentPrice);
    }
    const updated = await prisma.payment.update({
        where: { id },
        data: {
            month: parsed.data.month,
            notes: parsed.data.notes,
            amount,
            ...(floor !== null ? { floor } : {}),
            ...(apartmentNumber !== null ? { apartmentNumber } : {}),
        },
    });
    res.json(updated);
});
app.delete("/api/payments/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const existing = await prisma.payment.findUnique({ where: { id } });
    if (!existing)
        return res.status(404).json({ message: "Paiement introuvable" });
    await prisma.payment.delete({ where: { id } });
    res.json({ message: "Paiement supprimé" });
});
app.put("/api/expenses/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        category: zod_1.z.string().min(1),
        amount: zod_1.z.number().positive(),
        comment: zod_1.z.string().optional(),
        date: zod_1.z.string().min(1),
        apartmentNumber: zod_1.z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const existing = await prisma.expense.findUnique({ where: { id } });
    if (!existing)
        return res.status(404).json({ message: "Dépense introuvable" });
    if (existing.expenseType === client_1.ExpenseType.PRIVATE && !parsed.data.apartmentNumber?.trim()) {
        return res.status(400).json({ message: "Appartement requis pour une depense privee" });
    }
    const updated = await prisma.expense.update({
        where: { id },
        data: {
            category: parsed.data.category,
            amount: money(parsed.data.amount),
            comment: parsed.data.comment,
            date: new Date(parsed.data.date),
            apartmentNumber: parsed.data.apartmentNumber,
        },
    });
    res.json(updated);
});
app.delete("/api/expenses/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const existing = await prisma.expense.findUnique({ where: { id } });
    if (!existing)
        return res.status(404).json({ message: "Dépense introuvable" });
    await prisma.expense.delete({ where: { id } });
    res.json({ message: "Dépense supprimée" });
});
app.post("/api/comments", auth, allow(client_1.Role.OWNER), async (req, res) => {
    const schema = zod_1.z.object({
        transactionType: zod_1.z.enum(["payment", "expense"]),
        transactionId: zod_1.z.string().min(1),
        content: zod_1.z.string().min(1).max(500),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const data = parsed.data.transactionType === "payment"
        ? { paymentId: parsed.data.transactionId, createdById: req.user.id, content: parsed.data.content }
        : { expenseId: parsed.data.transactionId, createdById: req.user.id, content: parsed.data.content };
    const comment = await prisma.comment.create({ data });
    res.status(201).json(comment);
});
app.get("/api/dashboard", auth, async (_req, res) => {
    const [payments, expenses, houses, studios] = await Promise.all([
        prisma.payment.findMany({ include: { house: true, studio: true, comments: { include: { createdBy: true } } }, orderBy: { date: "desc" } }),
        prisma.expense.findMany({ include: { house: true, studio: true, comments: { include: { createdBy: true } } }, orderBy: { date: "desc" } }),
        listHousesWithLayout(),
        prisma.studio.findMany({ orderBy: { createdAt: "desc" } }),
    ]);
    const paymentDto = payments.map((p) => ({
        id: p.id,
        propertyId: p.houseId ?? p.studioId,
        propertyType: p.propertyType === client_1.PropertyType.HOUSE ? "house" : "studio",
        propertyLabel: p.house?.address ?? p.studio?.address ?? "Inconnu",
        month: p.month,
        amount: money(p.amount),
        date: p.date.toISOString(),
        notes: p.notes ?? "",
        floor: p.floor ?? null,
        apartmentNumber: p.apartmentNumber ?? null,
        comments: p.comments.map((c) => ({ id: c.id, content: c.content, author: c.createdBy.username, createdAt: c.createdAt.toISOString() })),
    }));
    const expenseDto = expenses.map((e) => ({
        id: e.id,
        expenseType: e.expenseType === client_1.ExpenseType.COMMON ? "common" : "private",
        propertyId: e.houseId ?? e.studioId,
        propertyType: e.propertyType === client_1.PropertyType.HOUSE ? "house" : "studio",
        propertyLabel: e.house?.address ?? e.studio?.address ?? "Inconnu",
        apartmentNumber: e.apartmentNumber ?? "",
        category: e.category,
        amount: money(e.amount),
        comment: e.comment ?? "",
        date: e.date.toISOString(),
        comments: e.comments.map((c) => ({ id: c.id, content: c.content, author: c.createdBy.username, createdAt: c.createdAt.toISOString() })),
    }));
    return res.json({ houses, studios, payments: paymentDto, expenses: expenseDto });
});
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ message: "Erreur interne serveur" });
});
app.listen(PORT, () => {
    console.log(`Backend démarré sur http://localhost:${PORT}`);
});
