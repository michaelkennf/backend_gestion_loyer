"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const multer_1 = __importDefault(require("multer"));
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
const AUTH_DEBUG = process.env.AUTH_DEBUG === "1" || process.env.NODE_ENV !== "production";
const uploadsDir = path_1.default.resolve(process.cwd(), "uploads", "contracts");
fs_1.default.mkdirSync(uploadsDir, { recursive: true });
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname || ".pdf") || ".pdf";
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext.toLowerCase()}`);
    },
});
const uploadPdf = (0, multer_1.default)({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
        if (!ok)
            return cb(new Error("Seuls les fichiers PDF sont autorisés"));
        return cb(null, true);
    },
});
const allowedOrigins = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...(process.env.CORS_ORIGIN || "").split(","),
]
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean));
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        // Allow tools like curl/postman with no Origin header.
        if (!origin)
            return callback(null, true);
        const normalizedOrigin = origin.trim().replace(/\/+$/, "");
        if (allowedOrigins.has(normalizedOrigin))
            return callback(null, true);
        return callback(new Error("Origine non autorisée par CORS"));
    },
}));
app.set("etag", false);
app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
});
app.use("/uploads", express_1.default.static(path_1.default.resolve(process.cwd(), "uploads")));
app.use(express_1.default.json());
app.use((0, morgan_1.default)("dev"));
app.use((0, express_rate_limit_1.default)({ windowMs: 15 * 60 * 1000, max: 300 }));
/** Immeuble : au moins un niveau au rez-de-chaussée (floor 0), comme le formulaire « ajouter un immeuble ». */
function layoutIndicatesBuilding(layout) {
    if (!Array.isArray(layout))
        return false;
    return layout.some((lvl) => {
        if (typeof lvl !== "object" || lvl === null)
            return false;
        return lvl.floor === 0;
    });
}
/** Rattrapage affichage/API : anciennes lignes avec isBuilding=false alors que le layout est celui d’un immeuble. */
function normalizeHouseRow(row) {
    return {
        ...row,
        isBuilding: row.isBuilding || layoutIndicatesBuilding(row.layout),
    };
}
function signToken(user) {
    return jsonwebtoken_1.default.sign(user, JWT_SECRET, { expiresIn: "8h" });
}
function signRefreshToken(user) {
    return jsonwebtoken_1.default.sign(user, JWT_REFRESH_SECRET, { expiresIn: "7d" });
}
function authDebugLog(event, details) {
    if (!AUTH_DEBUG)
        return;
    console.info(`[AUTH_DEBUG] ${event}`, details);
}
function money(value) {
    return Number(value.toFixed(2));
}
function rentalDepositUnitKey(propertyType, propertyId, floor, apartmentNumber) {
    if (propertyType === "studio")
        return `studio:${propertyId}`;
    if (propertyType === "land")
        return `land:${propertyId}`;
    return `house:${propertyId}:${floor}:${apartmentNumber}`;
}
function mapRentalDepositDto(r) {
    const address = r.house?.address ?? r.studio?.address ?? r.land?.address ?? "Inconnu";
    const propertyType = r.houseId != null ? (r.house.isBuilding ? "building" : "house") : r.studioId != null ? "studio" : "land";
    return {
        id: r.id,
        tenantName: r.tenantName,
        balance: money(r.balance),
        notes: r.notes ?? "",
        propertyId: r.houseId ?? r.studioId ?? r.landId ?? "",
        propertyLabel: address,
        propertyType,
        floor: r.floor,
        apartmentNumber: r.apartmentNumber,
        updatedAt: r.updatedAt.toISOString(),
    };
}
async function listRentalDepositsDto() {
    const rows = await prisma.rentalDeposit.findMany({
        orderBy: { updatedAt: "desc" },
        include: { house: true, studio: true, land: true },
    });
    return rows.map(mapRentalDepositDto);
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
    if (propertyType === "house" || propertyType === "building") {
        const house = await prisma.house.findUnique({ where: { id: propertyId }, select: { id: true } });
        return Boolean(house);
    }
    if (propertyType === "land") {
        const land = await prisma.land.findUnique({ where: { id: propertyId }, select: { id: true } });
        return Boolean(land);
    }
    const studio = await prisma.studio.findUnique({ where: { id: propertyId }, select: { id: true } });
    return Boolean(studio);
}
async function getHouseByIdWithLayout(id) {
    const rows = await prisma.$queryRaw `
    SELECT "id","address","floors","apartments","rentPrice","isBuilding","createdById","createdAt","updatedAt","layout"
    FROM "House"
    WHERE "id" = ${id}
    LIMIT 1
  `;
    const row = rows[0];
    return row ? normalizeHouseRow(row) : null;
}
async function listHousesWithLayout() {
    const rows = await prisma.$queryRaw `
    SELECT "id","address","floors","apartments","rentPrice","isBuilding","createdById","createdAt","updatedAt","layout"
    FROM "House"
    ORDER BY "createdAt" DESC
  `;
    return rows.map(normalizeHouseRow);
}
async function updateHouseWithLayout(id, data) {
    await prisma.$executeRaw `
    UPDATE "House"
    SET "address" = ${data.address},
        "floors" = ${data.floors},
        "apartments" = ${data.apartments},
        "rentPrice" = ${data.rentPrice},
        "layout" = ${JSON.stringify(data.layout)}::jsonb,
        "isBuilding" = ${data.isBuilding},
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
    const schema = zod_1.z.object({ username: zod_1.z.string().trim().min(1), password: zod_1.z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const username = parsed.data.username.trim();
    const user = await prisma.user.findFirst({
        where: { username: { equals: username, mode: "insensitive" } },
    });
    if (!user) {
        authDebugLog("login_user_not_found", { username });
        return res.status(401).json({ message: "Identifiants invalides" });
    }
    const ok = await bcryptjs_1.default.compare(parsed.data.password, user.passwordHash);
    if (!ok) {
        authDebugLog("login_bad_password", { usernameInput: username, usernameMatched: user.username, userId: user.id });
        return res.status(401).json({ message: "Identifiants invalides" });
    }
    authDebugLog("login_success", { usernameInput: username, usernameMatched: user.username, userId: user.id, role: user.role });
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
        username: zod_1.z.string().trim().min(3),
        fullName: zod_1.z.string().min(3),
        role: zod_1.z.enum([client_1.Role.ADMIN, client_1.Role.MANAGER, client_1.Role.OWNER]),
        password: zod_1.z.string().min(6),
        forceReset: zod_1.z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const username = parsed.data.username.trim().toLowerCase();
    const { fullName, role, password, forceReset } = parsed.data;
    const existing = await prisma.user.findFirst({
        where: { username: { equals: username, mode: "insensitive" } },
        select: { id: true },
    });
    if (existing)
        return res.status(409).json({ message: "Identifiant déjà utilisé" });
    const hash = await bcryptjs_1.default.hash(password, 10);
    const user = await prisma.user.create({
        data: { username, fullName, role, passwordHash: hash, forceReset: forceReset ?? true },
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
    const [houses, studios, lands] = await Promise.all([
        listHousesWithLayout(),
        prisma.studio.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.land.findMany({ orderBy: { createdAt: "desc" } }),
    ]);
    res.json({ houses, studios, lands });
});
app.post("/api/properties/houses", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        address: zod_1.z.string().min(3),
        levels: zod_1.z.array(zod_1.z.object({
            floor: zod_1.z.number().int().min(0),
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
    const isBuilding = levels.some((l) => l.floor === 0);
    const house = await prisma.house.create({
        data: {
            address: parsed.data.address,
            floors,
            apartments,
            rentPrice,
            layout: levels,
            isBuilding,
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
app.post("/api/properties/lands", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        address: zod_1.z.string().min(3),
        size: zod_1.z.number().positive(),
        monthlyRent: zod_1.z.number().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const land = await prisma.land.create({
        data: {
            address: parsed.data.address,
            size: money(parsed.data.size),
            monthlyRent: money(parsed.data.monthlyRent),
            createdById: req.user.id,
        },
    });
    res.status(201).json(land);
});
app.put("/api/properties/lands/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        address: zod_1.z.string().min(3),
        size: zod_1.z.number().positive(),
        monthlyRent: zod_1.z.number().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const existing = await prisma.land.findUnique({ where: { id } });
    if (!existing)
        return res.status(404).json({ message: "Terrain introuvable" });
    const updated = await prisma.land.update({
        where: { id },
        data: {
            address: parsed.data.address,
            size: money(parsed.data.size),
            monthlyRent: money(parsed.data.monthlyRent),
        },
    });
    res.json(updated);
});
app.delete("/api/properties/lands/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const existing = await prisma.land.findUnique({ where: { id } });
    if (!existing)
        return res.status(404).json({ message: "Terrain introuvable" });
    await prisma.land.delete({ where: { id } });
    res.json({ message: "Terrain supprimé" });
});
app.put("/api/properties/houses/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        address: zod_1.z.string().min(3),
        levels: zod_1.z.array(zod_1.z.object({
            floor: zod_1.z.number().int().min(0),
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
    const isBuilding = levels.some((l) => l.floor === 0);
    await updateHouseWithLayout(id, {
        address: parsed.data.address,
        floors,
        apartments,
        rentPrice,
        layout: levels,
        isBuilding,
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
app.post("/api/payments", auth, allow(client_1.Role.MANAGER), uploadPdf.single("contractFile"), async (req, res) => {
    const schema = zod_1.z.object({
        propertyType: zod_1.z.enum(["house", "building", "studio", "land"]),
        propertyId: zod_1.z.string().min(1),
        paymentKind: zod_1.z.enum(["rental", "monthly"]),
        tenantName: zod_1.z.string().trim().min(2, "Nom du locataire requis"),
        month: zod_1.z.string().optional(),
        monthsCount: zod_1.z.coerce.number().int().min(1).optional(),
        amount: zod_1.z.coerce.number().positive().optional(),
        notes: zod_1.z.string().optional(),
        floor: zod_1.z.coerce.number().int().min(0).optional(),
        apartmentNumber: zod_1.z.coerce.number().int().min(1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    if (parsed.data.propertyType === "house" || parsed.data.propertyType === "building") {
        const house = await getHouseByIdWithLayout(parsed.data.propertyId);
        if (!house)
            return res.status(404).json({ message: "Propriete introuvable" });
        if (!Number.isInteger(parsed.data.floor) || !parsed.data.apartmentNumber) {
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
    else if (parsed.data.propertyType === "land") {
        const land = await prisma.land.findUnique({ where: { id: parsed.data.propertyId } });
        if (!land)
            return res.status(404).json({ message: "Terrain introuvable" });
        if (!parsed.data.amount || parsed.data.amount <= 0) {
            return res.status(400).json({ message: "Le montant est requis pour un terrain" });
        }
    }
    else {
        const exists = await propertyExists(parsed.data.propertyType, parsed.data.propertyId);
        if (!exists)
            return res.status(404).json({ message: "Propriete introuvable" });
        if (!parsed.data.amount || parsed.data.amount <= 0) {
            return res.status(400).json({ message: "Le montant est requis pour un studio" });
        }
    }
    if (parsed.data.paymentKind === "monthly") {
        if (!parsed.data.month || !/^\d{4}-\d{2}$/.test(parsed.data.month)) {
            return res.status(400).json({ message: "Mois requis au format AAAA-MM pour un paiement mensuel" });
        }
    }
    else if (!parsed.data.monthsCount || parsed.data.monthsCount < 1) {
        return res.status(400).json({ message: "Nombre de mois requis pour un loyer locatif" });
    }
    const isHouse = parsed.data.propertyType === "house" || parsed.data.propertyType === "building";
    const isLand = parsed.data.propertyType === "land";
    const floor = parsed.data.floor ?? null;
    const apartmentNumber = parsed.data.apartmentNumber ?? null;
    let amount = money(parsed.data.amount ?? 0);
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
            propertyType: isHouse ? client_1.PropertyType.HOUSE : isLand ? client_1.PropertyType.LAND : client_1.PropertyType.STUDIO,
            paymentKind: parsed.data.paymentKind === "rental" ? client_1.PaymentKind.RENTAL_RENT : client_1.PaymentKind.MONTHLY_PAYMENT,
            tenantName: parsed.data.tenantName,
            contractFilePath: req.file ? `/uploads/contracts/${req.file.filename}` : null,
            houseId: isHouse ? parsed.data.propertyId : null,
            studioId: !isHouse && !isLand ? parsed.data.propertyId : null,
            landId: isLand ? parsed.data.propertyId : null,
            month: parsed.data.month ?? new Date().toISOString().slice(0, 7),
            monthsCount: parsed.data.paymentKind === "rental" ? parsed.data.monthsCount ?? 1 : null,
            amount: money(amount),
            notes: parsed.data.notes,
            ...(isHouse && floor !== null ? { floor } : {}),
            ...(isHouse && apartmentNumber !== null ? { apartmentNumber } : {}),
            date: new Date(),
            createdById: req.user.id,
        },
    });
    res.status(201).json(payment);
});
app.get("/api/suppliers", auth, allow(client_1.Role.MANAGER), async (_req, res) => {
    const rows = await prisma.supplier.findMany({ orderBy: { name: "asc" } });
    res.json(rows.map((s) => ({ id: s.id, name: s.name, contact: s.contact })));
});
app.post("/api/suppliers", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        name: zod_1.z.string().trim().min(1, "Nom requis"),
        contact: zod_1.z.string().trim().min(1, "Contact requis"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const supplier = await prisma.supplier.create({
        data: {
            name: parsed.data.name,
            contact: parsed.data.contact,
            createdById: req.user.id,
        },
    });
    res.status(201).json({ id: supplier.id, name: supplier.name, contact: supplier.contact });
});
app.put("/api/suppliers/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        name: zod_1.z.string().trim().min(1, "Nom requis"),
        contact: zod_1.z.string().trim().min(1, "Contact requis"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const existing = await prisma.supplier.findUnique({ where: { id } });
    if (!existing)
        return res.status(404).json({ message: "Fournisseur introuvable" });
    const supplier = await prisma.supplier.update({
        where: { id },
        data: { name: parsed.data.name, contact: parsed.data.contact },
    });
    res.json({ id: supplier.id, name: supplier.name, contact: supplier.contact });
});
app.delete("/api/suppliers/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const existing = await prisma.supplier.findUnique({ where: { id } });
    if (!existing)
        return res.status(404).json({ message: "Fournisseur introuvable" });
    await prisma.supplier.delete({ where: { id } });
    res.json({ message: "Fournisseur supprimé" });
});
app.post("/api/expenses", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        expenseType: zod_1.z.enum(["common", "private"]),
        propertyType: zod_1.z.enum(["house", "building", "studio", "land"]),
        propertyId: zod_1.z.string().optional(),
        apartmentNumber: zod_1.z.string().optional(),
        category: zod_1.z.string().min(1),
        amount: zod_1.z.number().positive(),
        comment: zod_1.z.string().optional(),
        date: zod_1.z.string().min(1),
        supplierId: zod_1.z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    if (parsed.data.propertyType !== "land" && parsed.data.expenseType === "private" && !parsed.data.apartmentNumber?.trim()) {
        return res.status(400).json({ message: "Appartement requis pour une depense privee" });
    }
    const isLand = parsed.data.propertyType === "land";
    if (!parsed.data.propertyId?.trim()) {
        return res.status(400).json({ message: isLand ? "Terrain requis" : "Propriete requise" });
    }
    const propertyTypeForCheck = parsed.data.propertyType;
    const exists = await propertyExists(propertyTypeForCheck, parsed.data.propertyId);
    if (!exists)
        return res.status(404).json({ message: "Propriete introuvable" });
    const isHouse = parsed.data.propertyType === "house" || parsed.data.propertyType === "building";
    const isCommon = isLand ? true : parsed.data.expenseType === "common";
    let supplierId = null;
    if (isCommon && !isLand && parsed.data.supplierId?.trim()) {
        const sup = await prisma.supplier.findUnique({ where: { id: parsed.data.supplierId } });
        if (!sup)
            return res.status(400).json({ message: "Fournisseur introuvable" });
        supplierId = sup.id;
    }
    const expense = await prisma.expense.create({
        data: {
            expenseType: isLand ? client_1.ExpenseType.COMMON : (parsed.data.expenseType === "common" ? client_1.ExpenseType.COMMON : client_1.ExpenseType.PRIVATE),
            propertyType: isLand ? client_1.PropertyType.LAND : (isHouse ? client_1.PropertyType.HOUSE : client_1.PropertyType.STUDIO),
            houseId: !isLand && isHouse ? parsed.data.propertyId ?? null : null,
            studioId: !isLand && !isHouse ? parsed.data.propertyId ?? null : null,
            landId: isLand ? parsed.data.propertyId ?? null : null,
            apartmentNumber: isLand ? undefined : parsed.data.apartmentNumber,
            category: parsed.data.category,
            amount: money(parsed.data.amount),
            comment: parsed.data.comment,
            date: new Date(parsed.data.date),
            createdById: req.user.id,
            supplierId,
        },
    });
    res.status(201).json(expense);
});
app.put("/api/payments/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        month: zod_1.z.string().optional(),
        monthsCount: zod_1.z.coerce.number().int().min(1).optional(),
        notes: zod_1.z.string().optional(),
        paymentKind: zod_1.z.enum(["rental", "monthly"]).optional(),
        tenantName: zod_1.z.string().trim().min(2).optional(),
        floor: zod_1.z.number().int().min(0).optional(),
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
    const nextKind = parsed.data.paymentKind
        ? (parsed.data.paymentKind === "rental" ? client_1.PaymentKind.RENTAL_RENT : client_1.PaymentKind.MONTHLY_PAYMENT)
        : existing.paymentKind;
    const nextMonth = parsed.data.month ?? existing.month;
    const existingMonthsCount = existing.monthsCount ?? null;
    const nextMonthsCount = typeof parsed.data.monthsCount === "number" ? parsed.data.monthsCount : existingMonthsCount;
    if (nextKind === client_1.PaymentKind.MONTHLY_PAYMENT && !/^\d{4}-\d{2}$/.test(nextMonth)) {
        return res.status(400).json({ message: "Mois requis au format AAAA-MM pour un paiement mensuel" });
    }
    if (nextKind === client_1.PaymentKind.RENTAL_RENT && (!nextMonthsCount || nextMonthsCount < 1)) {
        return res.status(400).json({ message: "Nombre de mois requis pour un loyer locatif" });
    }
    const existingFloor = existing.floor ?? null;
    const existingApartmentNumber = existing.apartmentNumber ?? null;
    let amount = parsed.data.amount ? money(parsed.data.amount) : money(existing.amount);
    let floor = parsed.data.floor ?? existingFloor;
    let apartmentNumber = parsed.data.apartmentNumber ?? existingApartmentNumber;
    if (existing.propertyType === client_1.PropertyType.HOUSE) {
        if (!Number.isInteger(floor) || !apartmentNumber) {
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
            month: nextMonth,
            notes: parsed.data.notes,
            paymentKind: nextKind,
            monthsCount: nextKind === client_1.PaymentKind.RENTAL_RENT ? nextMonthsCount : null,
            ...(parsed.data.tenantName ? { tenantName: parsed.data.tenantName.trim() } : {}),
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
        supplierId: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
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
    let supplierUpdate;
    if (existing.expenseType === client_1.ExpenseType.COMMON && parsed.data.supplierId !== undefined) {
        if (parsed.data.supplierId === null) {
            supplierUpdate = { disconnect: true };
        }
        else {
            const sup = await prisma.supplier.findUnique({ where: { id: parsed.data.supplierId } });
            if (!sup)
                return res.status(400).json({ message: "Fournisseur introuvable" });
            supplierUpdate = { connect: { id: sup.id } };
        }
    }
    const updated = await prisma.expense.update({
        where: { id },
        data: {
            category: parsed.data.category,
            amount: money(parsed.data.amount),
            comment: parsed.data.comment,
            date: new Date(parsed.data.date),
            apartmentNumber: parsed.data.apartmentNumber,
            ...(supplierUpdate !== undefined ? { supplier: supplierUpdate } : {}),
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
app.post("/api/rental-deposits", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const schema = zod_1.z.object({
        propertyType: zod_1.z.enum(["house", "building", "studio", "land"]),
        propertyId: zod_1.z.string().min(1),
        tenantName: zod_1.z.string().trim().min(2),
        balance: zod_1.z.number().min(0),
        notes: zod_1.z.string().optional(),
        floor: zod_1.z.coerce.number().int().min(0).optional(),
        apartmentNumber: zod_1.z.coerce.number().int().min(1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const isHouse = parsed.data.propertyType === "house" || parsed.data.propertyType === "building";
    if (isHouse) {
        if (!Number.isInteger(parsed.data.floor) || !parsed.data.apartmentNumber) {
            return res.status(400).json({ message: "Niveau et appartement requis pour une maison ou un immeuble" });
        }
        const house = await getHouseByIdWithLayout(parsed.data.propertyId);
        if (!house)
            return res.status(404).json({ message: "Propriete introuvable" });
        const layout = house.layout;
        const level = layout.find((l) => l.floor === parsed.data.floor);
        const apartment = level?.apartments.find((a) => a.number === parsed.data.apartmentNumber);
        if (!level || !apartment)
            return res.status(400).json({ message: "Appartement invalide pour ce niveau" });
    }
    else if (parsed.data.propertyType === "land") {
        const land = await prisma.land.findUnique({ where: { id: parsed.data.propertyId } });
        if (!land)
            return res.status(404).json({ message: "Terrain introuvable" });
    }
    else {
        const studio = await prisma.studio.findUnique({ where: { id: parsed.data.propertyId } });
        if (!studio)
            return res.status(404).json({ message: "Studio introuvable" });
    }
    const key = rentalDepositUnitKey(parsed.data.propertyType, parsed.data.propertyId, parsed.data.floor, parsed.data.apartmentNumber);
    const row = await prisma.rentalDeposit.upsert({
        where: { propertyUnitKey: key },
        create: {
            propertyUnitKey: key,
            tenantName: parsed.data.tenantName,
            balance: money(parsed.data.balance),
            notes: parsed.data.notes?.trim() || null,
            houseId: isHouse ? parsed.data.propertyId : null,
            studioId: parsed.data.propertyType === "studio" ? parsed.data.propertyId : null,
            landId: parsed.data.propertyType === "land" ? parsed.data.propertyId : null,
            floor: isHouse ? parsed.data.floor : null,
            apartmentNumber: isHouse ? parsed.data.apartmentNumber : null,
            createdById: req.user.id,
        },
        update: {
            tenantName: parsed.data.tenantName,
            balance: money(parsed.data.balance),
            notes: parsed.data.notes?.trim() || null,
        },
    });
    const withRelations = await prisma.rentalDeposit.findUnique({
        where: { id: row.id },
        include: { house: true, studio: true, land: true },
    });
    if (!withRelations)
        return res.status(500).json({ message: "Erreur interne" });
    return res.status(201).json(mapRentalDepositDto(withRelations));
});
app.delete("/api/rental-deposits/:id", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const existing = await prisma.rentalDeposit.findUnique({ where: { id } });
    if (!existing)
        return res.status(404).json({ message: "Garantie introuvable" });
    await prisma.rentalDeposit.delete({ where: { id } });
    res.json({ message: "Garantie supprimee" });
});
app.post("/api/rental-deposits/:id/transactions", auth, allow(client_1.Role.MANAGER), async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const schema = zod_1.z.object({
        kind: zod_1.z.enum(["expense", "refund"]),
        amount: zod_1.z.coerce.number().positive(),
        comment: zod_1.z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ message: "Payload invalide" });
    const deposit = await prisma.rentalDeposit.findUnique({
        where: { id },
        include: { house: true, studio: true, land: true },
    });
    if (!deposit)
        return res.status(404).json({ message: "Garantie introuvable" });
    const amount = money(parsed.data.amount);
    if (amount > deposit.balance) {
        return res.status(400).json({ message: "Montant supérieur au solde de la garantie locative" });
    }
    const nextBalance = money(deposit.balance - amount);
    const type = parsed.data.kind === "expense" ? "EXPENSE" : "REFUND";
    const updated = await prisma.$transaction(async (tx) => {
        await tx.rentalDepositTransaction.create({
            data: {
                rentalDepositId: deposit.id,
                type: type,
                amount,
                comment: parsed.data.comment?.trim() || null,
                createdById: req.user.id,
            },
        });
        return tx.rentalDeposit.update({
            where: { id: deposit.id },
            data: { balance: nextBalance },
            include: { house: true, studio: true, land: true },
        });
    });
    return res.status(201).json(mapRentalDepositDto(updated));
});
app.get("/api/dashboard", auth, async (_req, res) => {
    const [payments, expenses, houses, studios, lands, suppliers, rentalDeposits] = await Promise.all([
        prisma.payment.findMany({ include: { house: true, studio: true, land: true, comments: { include: { createdBy: true } } }, orderBy: { date: "desc" } }),
        prisma.expense.findMany({
            include: { house: true, studio: true, land: true, supplier: true, comments: { include: { createdBy: true } } },
            orderBy: { date: "desc" },
        }),
        listHousesWithLayout(),
        prisma.studio.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.land.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.supplier.findMany({ orderBy: { name: "asc" } }),
        listRentalDepositsDto(),
    ]);
    const paymentDto = payments.map((p) => ({
        id: p.id,
        propertyId: p.landId ?? p.houseId ?? p.studioId ?? "",
        propertyType: p.propertyType === client_1.PropertyType.LAND ? "land" : p.propertyType === client_1.PropertyType.HOUSE ? "house" : "studio",
        propertyLabel: p.land?.address ?? p.house?.address ?? p.studio?.address ?? "Inconnu",
        month: p.month,
        paymentKind: (p.paymentKind === client_1.PaymentKind.RENTAL_RENT ? "rental" : "monthly"),
        monthsCount: p.monthsCount ?? null,
        tenantName: p.tenantName ?? "",
        contractFileUrl: p.contractFilePath ?? "",
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
        propertyId: e.landId ?? e.houseId ?? e.studioId ?? "",
        propertyType: e.propertyType === client_1.PropertyType.LAND ? "land" : (e.propertyType === client_1.PropertyType.HOUSE ? "house" : "studio"),
        propertyLabel: e.propertyType === client_1.PropertyType.LAND ? (e.land?.address ?? "Terrain") : (e.house?.address ?? e.studio?.address ?? "Inconnu"),
        apartmentNumber: e.apartmentNumber ?? "",
        category: e.category,
        amount: money(e.amount),
        comment: e.comment ?? "",
        date: e.date.toISOString(),
        supplierId: e.supplierId ?? null,
        supplierName: e.supplier?.name ?? null,
        supplierContact: e.supplier?.contact ?? null,
        comments: e.comments.map((c) => ({ id: c.id, content: c.content, author: c.createdBy.username, createdAt: c.createdAt.toISOString() })),
    }));
    const supplierDto = suppliers.map((s) => ({ id: s.id, name: s.name, contact: s.contact }));
    return res.json({
        houses,
        studios,
        lands,
        payments: paymentDto,
        expenses: expenseDto,
        suppliers: supplierDto,
        rentalDeposits,
    });
});
app.use((err, _req, res, _next) => {
    if (err instanceof multer_1.default.MulterError) {
        return res.status(400).json({ message: err.message });
    }
    if (err.message?.toLowerCase().includes("pdf")) {
        return res.status(400).json({ message: err.message });
    }
    console.error(err);
    res.status(500).json({ message: "Erreur interne serveur" });
});
app.listen(PORT, () => {
    console.log(`Backend démarré sur http://localhost:${PORT}`);
});
