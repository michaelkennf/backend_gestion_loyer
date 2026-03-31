import "dotenv/config";
import express from "express";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import { PrismaClient, Role, PropertyType, ExpenseType, PaymentKind } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { z } from "zod";

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "dev-refresh-secret";
const PORT = Number(process.env.PORT || 4000);
const AUTH_DEBUG = process.env.AUTH_DEBUG === "1" || process.env.NODE_ENV !== "production";
const uploadsDir = path.resolve(process.cwd(), "uploads", "contracts");
fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".pdf") || ".pdf";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext.toLowerCase()}`);
  },
});
const uploadPdf = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    if (!ok) return cb(new Error("Seuls les fichiers PDF sont autorisés"));
    return cb(null, true);
  },
});
const allowedOrigins = new Set(
  [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...(process.env.CORS_ORIGIN || "").split(","),
  ]
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean)
);

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow tools like curl/postman with no Origin header.
      if (!origin) return callback(null, true);
      const normalizedOrigin = origin.trim().replace(/\/+$/, "");
      if (allowedOrigins.has(normalizedOrigin)) return callback(null, true);
      return callback(new Error("Origine non autorisée par CORS"));
    },
  })
);
app.set("etag", false);
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});
app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads")));
app.use(express.json());
app.use(morgan("dev"));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

type AuthRequest = express.Request & { user?: { id: string; role: Role; username: string } };
type HouseLayout = { floor: number; apartments: { number: number; rentPrice: number }[] }[];
type HouseRowWithLayout = {
  id: string;
  address: string;
  floors: number;
  apartments: number;
  rentPrice: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  layout: unknown;
};

function signToken(user: { id: string; role: Role; username: string }) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "8h" });
}
function signRefreshToken(user: { id: string; role: Role; username: string }) {
  return jwt.sign(user, JWT_REFRESH_SECRET, { expiresIn: "7d" });
}

function authDebugLog(event: string, details: Record<string, unknown>) {
  if (!AUTH_DEBUG) return;
  console.info(`[AUTH_DEBUG] ${event}`, details);
}

function money(value: number) {
  return Number(value.toFixed(2));
}

function auth(req: AuthRequest, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ message: "Token manquant" });
  try {
    req.user = jwt.verify(token, JWT_SECRET) as AuthRequest["user"];
    next();
  } catch {
    return res.status(401).json({ message: "Token invalide" });
  }
}

async function propertyExists(propertyType: "house" | "building" | "studio", propertyId: string) {
  if (propertyType === "house" || propertyType === "building") {
    const house = await prisma.house.findUnique({ where: { id: propertyId }, select: { id: true } });
    return Boolean(house);
  }
  const studio = await prisma.studio.findUnique({ where: { id: propertyId }, select: { id: true } });
  return Boolean(studio);
}

async function getHouseByIdWithLayout(id: string) {
  const rows = await prisma.$queryRaw<HouseRowWithLayout[]>`
    SELECT "id","address","floors","apartments","rentPrice","createdById","createdAt","updatedAt","layout"
    FROM "House"
    WHERE "id" = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function listHousesWithLayout() {
  return prisma.$queryRaw<HouseRowWithLayout[]>`
    SELECT "id","address","floors","apartments","rentPrice","createdById","createdAt","updatedAt","layout"
    FROM "House"
    ORDER BY "createdAt" DESC
  `;
}

async function updateHouseWithLayout(id: string, data: {
  address: string;
  floors: number;
  apartments: number;
  rentPrice: number;
  layout: unknown;
}) {
  await prisma.$executeRaw`
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

async function deleteHouseById(id: string) {
  await prisma.$executeRaw`DELETE FROM "House" WHERE "id" = ${id}`;
}

function allow(...roles: Role[]) {
  return (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ message: "Accès refusé" });
    next();
  };
}

type RefreshTokenRow = {
  id: string;
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
};

async function createRefreshTokenRecord(userId: string, tokenHash: string, expiresAt: Date) {
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "RefreshToken" ("id", "tokenHash", "userId", "expiresAt", "createdAt")
    VALUES (${id}, ${tokenHash}, ${userId}, ${expiresAt}, NOW())
  `;
}

async function findRefreshTokensByUser(userId: string, limit: number) {
  return prisma.$queryRaw<RefreshTokenRow[]>`
    SELECT "id", "tokenHash", "userId", "expiresAt", "createdAt"
    FROM "RefreshToken"
    WHERE "userId" = ${userId} AND "expiresAt" > NOW()
    ORDER BY "createdAt" DESC
    LIMIT ${limit}
  `;
}

async function deleteRefreshTokenById(id: string) {
  await prisma.$executeRaw`DELETE FROM "RefreshToken" WHERE "id" = ${id}`;
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/login", async (req, res) => {
  const schema = z.object({ username: z.string().trim().min(1), password: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  const username = parsed.data.username.trim();
  const user = await prisma.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
  });
  if (!user) {
    authDebugLog("login_user_not_found", { username });
    return res.status(401).json({ message: "Identifiants invalides" });
  }
  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) {
    authDebugLog("login_bad_password", { usernameInput: username, usernameMatched: user.username, userId: user.id });
    return res.status(401).json({ message: "Identifiants invalides" });
  }
  authDebugLog("login_success", { usernameInput: username, usernameMatched: user.username, userId: user.id, role: user.role });
  const payload = { id: user.id, role: user.role, username: user.username };
  const token = signToken(payload);
  const refreshToken = signRefreshToken(payload);
  const tokenHash = await bcrypt.hash(refreshToken, 10);
  await createRefreshTokenRecord(user.id, tokenHash, new Date(Date.now() + 7 * 24 * 3600 * 1000));
  return res.json({
    token,
    refreshToken,
    user: { id: user.id, username: user.username, fullName: user.fullName, role: user.role, forceReset: user.forceReset },
  });
});

app.post("/api/auth/refresh", async (req, res) => {
  const schema = z.object({ refreshToken: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  let decoded: jwt.JwtPayload | string;
  try {
    decoded = jwt.verify(parsed.data.refreshToken, JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ message: "Refresh token invalide" });
  }
  if (typeof decoded === "string") return res.status(401).json({ message: "Refresh token invalide" });
  const payload = {
    id: String(decoded.id),
    role: decoded.role as Role,
    username: String(decoded.username),
  };
  if (!payload.id || !payload.role || !payload.username) {
    return res.status(401).json({ message: "Refresh token invalide" });
  }
  const candidates = await findRefreshTokensByUser(payload.id, 30);
  let matchedTokenId: string | null = null;
  for (const item of candidates) {
    const ok = await bcrypt.compare(parsed.data.refreshToken, item.tokenHash);
    if (ok) {
      matchedTokenId = item.id;
      break;
    }
  }
  if (!matchedTokenId) return res.status(401).json({ message: "Refresh token invalide" });
  const token = signToken(payload);
  const nextRefreshToken = signRefreshToken(payload);
  const nextTokenHash = await bcrypt.hash(nextRefreshToken, 10);
  await deleteRefreshTokenById(matchedTokenId);
  await createRefreshTokenRecord(payload.id, nextTokenHash, new Date(Date.now() + 7 * 24 * 3600 * 1000));
  return res.json({ token, refreshToken: nextRefreshToken });
});

app.post("/api/auth/logout", async (req, res) => {
  const schema = z.object({ refreshToken: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  if (!parsed.data.refreshToken) return res.json({ message: "OK" });
  let payload: { id: string };
  try {
    payload = jwt.verify(parsed.data.refreshToken, JWT_REFRESH_SECRET) as { id: string };
  } catch {
    return res.json({ message: "OK" });
  }
  const rows = await findRefreshTokensByUser(payload.id, 50);
  for (const row of rows) {
    const ok = await bcrypt.compare(parsed.data.refreshToken, row.tokenHash);
    if (ok) {
      await deleteRefreshTokenById(row.id);
      break;
    }
  }
  return res.json({ message: "OK" });
});

app.get("/api/auth/me", auth, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });
  return res.json({ id: user.id, username: user.username, fullName: user.fullName, role: user.role, forceReset: user.forceReset });
});

app.post("/api/auth/change-password", auth, async (req: AuthRequest, res) => {
  const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(6),
    confirmPassword: z.string().min(6),
  }).refine((v) => v.newPassword === v.confirmPassword, { message: "Confirmation invalide", path: ["confirmPassword"] });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });
  const ok = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!ok) return res.status(400).json({ message: "Mot de passe actuel incorrect" });
  const hash = await bcrypt.hash(parsed.data.newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash, forceReset: false } });
  return res.json({ message: "Mot de passe modifié" });
});

app.get("/api/users", auth, allow(Role.ADMIN), async (_req, res) => {
  const users = await prisma.user.findMany({ select: { id: true, username: true, fullName: true, role: true, forceReset: true, createdAt: true } });
  return res.json(users);
});

app.post("/api/users", auth, allow(Role.ADMIN), async (req, res) => {
  const schema = z.object({
    username: z.string().trim().min(3),
    fullName: z.string().min(3),
    role: z.enum([Role.ADMIN, Role.MANAGER, Role.OWNER]),
    password: z.string().min(6),
    forceReset: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  const username = parsed.data.username.trim().toLowerCase();
  const { fullName, role, password, forceReset } = parsed.data;
  const existing = await prisma.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) return res.status(409).json({ message: "Identifiant déjà utilisé" });
  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { username, fullName, role, passwordHash: hash, forceReset: forceReset ?? true },
    select: { id: true, username: true, fullName: true, role: true, forceReset: true },
  });
  return res.status(201).json(user);
});

app.post("/api/users/:id/reset-password", auth, allow(Role.ADMIN), async (req, res) => {
  const schema = z.object({ newPassword: z.string().min(6) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  const hash = await bcrypt.hash(parsed.data.newPassword, 10);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  await prisma.user.update({ where: { id }, data: { passwordHash: hash, forceReset: true } });
  return res.json({ message: "Mot de passe réinitialisé" });
});

app.get("/api/properties", auth, async (_req: AuthRequest, res) => {
  const [houses, studios] = await Promise.all([listHousesWithLayout(), prisma.studio.findMany({ orderBy: { createdAt: "desc" } })]);
  res.json({ houses, studios });
});

app.post("/api/properties/houses", auth, allow(Role.MANAGER), async (req: AuthRequest, res) => {
  const schema = z.object({
    address: z.string().min(3),
    levels: z.array(
      z.object({
        floor: z.number().int().min(1),
        apartments: z.array(
          z.object({
            number: z.number().int().min(1),
            rentPrice: z.number().positive(),
          })
        ).min(1),
      })
    ).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  const levels = parsed.data.levels.map((lvl) => ({
    floor: lvl.floor,
    apartments: lvl.apartments.map((apt) => ({ number: apt.number, rentPrice: money(apt.rentPrice) })),
  }));
  const floors = levels.length;
  const apartments = levels.reduce((sum, lvl) => sum + lvl.apartments.length, 0);
  const totalRent = levels.reduce(
    (sum, lvl) => sum + lvl.apartments.reduce((s, apt) => s + apt.rentPrice, 0),
    0
  );
  const rentPrice = apartments > 0 ? money(totalRent / apartments) : 0;
  const house = await (prisma.house.create as unknown as (args: unknown) => Promise<unknown>)({
    data: {
      address: parsed.data.address,
      floors,
      apartments,
      rentPrice,
      layout: levels,
      createdById: req.user!.id,
    },
  });
  res.status(201).json(house);
});

app.post("/api/properties/studios", auth, allow(Role.MANAGER), async (req: AuthRequest, res) => {
  const schema = z.object({ address: z.string().min(3), monthlyRent: z.number().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  const studio = await prisma.studio.create({
    data: { ...parsed.data, monthlyRent: money(parsed.data.monthlyRent), createdById: req.user!.id },
  });
  res.status(201).json(studio);
});

app.put("/api/properties/houses/:id", auth, allow(Role.MANAGER), async (req: AuthRequest, res) => {
  const schema = z.object({
    address: z.string().min(3),
    levels: z.array(
      z.object({
        floor: z.number().int().min(1),
        apartments: z.array(z.object({ number: z.number().int().min(1), rentPrice: z.number().positive() })).min(1),
      })
    ).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const house = await getHouseByIdWithLayout(id);
  if (!house) return res.status(404).json({ message: "Maison introuvable" });

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

app.delete("/api/properties/houses/:id", auth, allow(Role.MANAGER), async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const house = await getHouseByIdWithLayout(id);
  if (!house) return res.status(404).json({ message: "Maison introuvable" });
  await deleteHouseById(id);
  res.json({ message: "Maison supprimée" });
});

app.put("/api/properties/studios/:id", auth, allow(Role.MANAGER), async (req, res) => {
  const schema = z.object({ address: z.string().min(3), monthlyRent: z.number().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const studio = await prisma.studio.findUnique({ where: { id } });
  if (!studio) return res.status(404).json({ message: "Studio introuvable" });
  const updated = await prisma.studio.update({
    where: { id },
    data: { address: parsed.data.address, monthlyRent: money(parsed.data.monthlyRent) },
  });
  res.json(updated);
});

app.delete("/api/properties/studios/:id", auth, allow(Role.MANAGER), async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const studio = await prisma.studio.findUnique({ where: { id } });
  if (!studio) return res.status(404).json({ message: "Studio introuvable" });
  await prisma.studio.delete({ where: { id } });
  res.json({ message: "Studio supprimé" });
});

app.post("/api/payments", auth, allow(Role.MANAGER), uploadPdf.single("contractFile"), async (req: AuthRequest, res) => {
  const schema = z.object({
    propertyType: z.enum(["house", "building", "studio"]),
    propertyId: z.string().min(1),
    paymentKind: z.enum(["rental", "monthly"]),
    tenantName: z.string().trim().min(2, "Nom du locataire requis"),
    month: z.string().optional(),
    monthsCount: z.coerce.number().int().min(1).optional(),
    amount: z.coerce.number().positive().optional(),
    notes: z.string().optional(),
    floor: z.coerce.number().int().min(1).optional(),
    apartmentNumber: z.coerce.number().int().min(1).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  if (parsed.data.propertyType === "house" || parsed.data.propertyType === "building") {
    const house = await getHouseByIdWithLayout(parsed.data.propertyId);
    if (!house) return res.status(404).json({ message: "Propriete introuvable" });
    if (!parsed.data.floor || !parsed.data.apartmentNumber) {
      return res.status(400).json({ message: "Niveau et appartement sont requis pour une maison" });
    }
    const layout = house.layout as HouseLayout;
    const level = layout.find((l) => l.floor === parsed.data.floor);
    if (!level) return res.status(400).json({ message: "Niveau invalide" });
    const apartment = level.apartments.find((a) => a.number === parsed.data.apartmentNumber);
    if (!apartment) return res.status(400).json({ message: "Appartement invalide pour ce niveau" });
  } else {
    const exists = await propertyExists(parsed.data.propertyType, parsed.data.propertyId);
    if (!exists) return res.status(404).json({ message: "Propriete introuvable" });
    if (!parsed.data.amount || parsed.data.amount <= 0) {
      return res.status(400).json({ message: "Le montant est requis pour un studio" });
    }
  }
  if (parsed.data.paymentKind === "monthly") {
    if (!parsed.data.month || !/^\d{4}-\d{2}$/.test(parsed.data.month)) {
      return res.status(400).json({ message: "Mois requis au format AAAA-MM pour un paiement mensuel" });
    }
  } else if (!parsed.data.monthsCount || parsed.data.monthsCount < 1) {
    return res.status(400).json({ message: "Nombre de mois requis pour un loyer locatif" });
  }
  const isHouse = parsed.data.propertyType === "house" || parsed.data.propertyType === "building";
  const floor = parsed.data.floor ?? null;
  const apartmentNumber = parsed.data.apartmentNumber ?? null;
  let amount = money(parsed.data.amount ?? 0);
  if (isHouse) {
    const house = await getHouseByIdWithLayout(parsed.data.propertyId);
    const layout = (house?.layout ?? []) as HouseLayout;
    const level = layout.find((l) => l.floor === floor);
    const apartment = level?.apartments.find((a) => a.number === apartmentNumber);
    if (!apartment) return res.status(400).json({ message: "Appartement introuvable" });
    amount = money(apartment.rentPrice);
  }
  const payment = await prisma.payment.create({
    data: {
      propertyType: isHouse ? PropertyType.HOUSE : PropertyType.STUDIO,
      paymentKind: parsed.data.paymentKind === "rental" ? PaymentKind.RENTAL_RENT : PaymentKind.MONTHLY_PAYMENT,
      tenantName: parsed.data.tenantName,
      contractFilePath: req.file ? `/uploads/contracts/${req.file.filename}` : null,
      houseId: isHouse ? parsed.data.propertyId : null,
      studioId: isHouse ? null : parsed.data.propertyId,
      month: parsed.data.month ?? new Date().toISOString().slice(0, 7),
      monthsCount: parsed.data.paymentKind === "rental" ? parsed.data.monthsCount ?? 1 : null,
      amount: money(amount),
      notes: parsed.data.notes,
      ...(floor !== null ? ({ floor } as Record<string, unknown>) : {}),
      ...(apartmentNumber !== null ? ({ apartmentNumber } as Record<string, unknown>) : {}),
      date: new Date(),
      createdById: req.user!.id,
    },
  });
  res.status(201).json(payment);
});

app.post("/api/expenses", auth, allow(Role.MANAGER), async (req: AuthRequest, res) => {
  const schema = z.object({
    expenseType: z.enum(["common", "private"]),
    propertyType: z.enum(["house", "building", "studio", "land"]),
    propertyId: z.string().optional(),
    apartmentNumber: z.string().optional(),
    category: z.string().min(1),
    amount: z.number().positive(),
    comment: z.string().optional(),
    date: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  if (parsed.data.propertyType !== "land" && parsed.data.expenseType === "private" && !parsed.data.apartmentNumber?.trim()) {
    return res.status(400).json({ message: "Appartement requis pour une depense privee" });
  }
  const isLand = parsed.data.propertyType === "land";
  if (!isLand) {
    if (!parsed.data.propertyId) return res.status(400).json({ message: "Propriete requise" });
    const propertyType = parsed.data.propertyType as "house" | "building" | "studio";
    const exists = await propertyExists(propertyType, parsed.data.propertyId);
    if (!exists) return res.status(404).json({ message: "Propriete introuvable" });
  }
  const isHouse = parsed.data.propertyType === "house" || parsed.data.propertyType === "building";
  const expense = await prisma.expense.create({
    data: {
      expenseType: isLand ? ExpenseType.COMMON : (parsed.data.expenseType === "common" ? ExpenseType.COMMON : ExpenseType.PRIVATE),
      propertyType: isLand ? PropertyType.LAND : (isHouse ? PropertyType.HOUSE : PropertyType.STUDIO),
      houseId: !isLand && isHouse ? parsed.data.propertyId ?? null : null,
      studioId: !isLand && !isHouse ? parsed.data.propertyId ?? null : null,
      apartmentNumber: isLand ? undefined : parsed.data.apartmentNumber,
      category: parsed.data.category,
      amount: money(parsed.data.amount),
      comment: parsed.data.comment,
      date: new Date(parsed.data.date),
      createdById: req.user!.id,
    },
  });
  res.status(201).json(expense);
});

app.put("/api/payments/:id", auth, allow(Role.MANAGER), async (req: AuthRequest, res) => {
  const schema = z.object({
    month: z.string().optional(),
    monthsCount: z.coerce.number().int().min(1).optional(),
    notes: z.string().optional(),
    paymentKind: z.enum(["rental", "monthly"]).optional(),
    tenantName: z.string().trim().min(2).optional(),
    floor: z.number().int().min(1).optional(),
    apartmentNumber: z.number().int().min(1).optional(),
    amount: z.number().positive().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const existing = await prisma.payment.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ message: "Paiement introuvable" });
  const nextKind = parsed.data.paymentKind
    ? (parsed.data.paymentKind === "rental" ? PaymentKind.RENTAL_RENT : PaymentKind.MONTHLY_PAYMENT)
    : existing.paymentKind;
  const nextMonth = parsed.data.month ?? existing.month;
  const existingMonthsCount = (existing as { monthsCount?: number | null }).monthsCount ?? null;
  const nextMonthsCount = typeof parsed.data.monthsCount === "number" ? parsed.data.monthsCount : existingMonthsCount;
  if (nextKind === PaymentKind.MONTHLY_PAYMENT && !/^\d{4}-\d{2}$/.test(nextMonth)) {
    return res.status(400).json({ message: "Mois requis au format AAAA-MM pour un paiement mensuel" });
  }
  if (nextKind === PaymentKind.RENTAL_RENT && (!nextMonthsCount || nextMonthsCount < 1)) {
    return res.status(400).json({ message: "Nombre de mois requis pour un loyer locatif" });
  }

  const existingFloor = (existing as { floor?: number | null }).floor ?? null;
  const existingApartmentNumber = (existing as { apartmentNumber?: number | null }).apartmentNumber ?? null;
  let amount = parsed.data.amount ? money(parsed.data.amount) : money(existing.amount);
  let floor = parsed.data.floor ?? existingFloor;
  let apartmentNumber = parsed.data.apartmentNumber ?? existingApartmentNumber;

  if (existing.propertyType === PropertyType.HOUSE) {
    if (!floor || !apartmentNumber) {
      return res.status(400).json({ message: "Niveau et appartement requis pour un paiement maison" });
    }
    const house = await getHouseByIdWithLayout(existing.houseId ?? "");
    if (!house) return res.status(404).json({ message: "Maison introuvable" });
    const layout = (house.layout ?? []) as HouseLayout;
    const level = layout.find((l) => l.floor === floor);
    const apartment = level?.apartments.find((a) => a.number === apartmentNumber);
    if (!apartment) return res.status(400).json({ message: "Appartement invalide" });
    amount = money(apartment.rentPrice);
  }

  const updated = await prisma.payment.update({
    where: { id },
    data: {
      month: nextMonth,
      notes: parsed.data.notes,
      paymentKind: nextKind,
      monthsCount: nextKind === PaymentKind.RENTAL_RENT ? nextMonthsCount : null,
      ...(parsed.data.tenantName ? { tenantName: parsed.data.tenantName.trim() } : {}),
      amount,
      ...(floor !== null ? ({ floor } as Record<string, unknown>) : {}),
      ...(apartmentNumber !== null ? ({ apartmentNumber } as Record<string, unknown>) : {}),
    },
  });
  res.json(updated);
});

app.delete("/api/payments/:id", auth, allow(Role.MANAGER), async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const existing = await prisma.payment.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ message: "Paiement introuvable" });
  await prisma.payment.delete({ where: { id } });
  res.json({ message: "Paiement supprimé" });
});

app.put("/api/expenses/:id", auth, allow(Role.MANAGER), async (req: AuthRequest, res) => {
  const schema = z.object({
    category: z.string().min(1),
    amount: z.number().positive(),
    comment: z.string().optional(),
    date: z.string().min(1),
    apartmentNumber: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ message: "Dépense introuvable" });
  if (existing.expenseType === ExpenseType.PRIVATE && !parsed.data.apartmentNumber?.trim()) {
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

app.delete("/api/expenses/:id", auth, allow(Role.MANAGER), async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ message: "Dépense introuvable" });
  await prisma.expense.delete({ where: { id } });
  res.json({ message: "Dépense supprimée" });
});

app.post("/api/comments", auth, allow(Role.OWNER), async (req: AuthRequest, res) => {
  const schema = z.object({
    transactionType: z.enum(["payment", "expense"]),
    transactionId: z.string().min(1),
    content: z.string().min(1).max(500),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Payload invalide" });
  const data = parsed.data.transactionType === "payment"
    ? { paymentId: parsed.data.transactionId, createdById: req.user!.id, content: parsed.data.content }
    : { expenseId: parsed.data.transactionId, createdById: req.user!.id, content: parsed.data.content };
  const comment = await prisma.comment.create({ data });
  res.status(201).json(comment);
});

app.get("/api/dashboard", auth, async (_req: AuthRequest, res) => {
  const [payments, expenses, houses, studios] = await Promise.all([
    prisma.payment.findMany({ include: { house: true, studio: true, comments: { include: { createdBy: true } } }, orderBy: { date: "desc" } }),
    prisma.expense.findMany({ include: { house: true, studio: true, comments: { include: { createdBy: true } } }, orderBy: { date: "desc" } }),
    listHousesWithLayout(),
    prisma.studio.findMany({ orderBy: { createdAt: "desc" } }),
  ]);
  const paymentDto = payments.map((p) => ({
    id: p.id,
    propertyId: p.houseId ?? p.studioId,
    propertyType: p.propertyType === PropertyType.HOUSE ? "house" : "studio",
    propertyLabel: p.house?.address ?? p.studio?.address ?? "Inconnu",
    month: p.month,
    paymentKind: (p.paymentKind === PaymentKind.RENTAL_RENT ? "rental" : "monthly"),
    monthsCount: (p as { monthsCount?: number | null }).monthsCount ?? null,
    tenantName: p.tenantName ?? "",
    contractFileUrl: p.contractFilePath ?? "",
    amount: money(p.amount),
    date: p.date.toISOString(),
    notes: p.notes ?? "",
    floor: (p as { floor?: number | null }).floor ?? null,
    apartmentNumber: (p as { apartmentNumber?: number | null }).apartmentNumber ?? null,
    comments: p.comments.map((c) => ({ id: c.id, content: c.content, author: c.createdBy.username, createdAt: c.createdAt.toISOString() })),
  }));
  const expenseDto = expenses.map((e) => ({
    id: e.id,
    expenseType: e.expenseType === ExpenseType.COMMON ? "common" : "private",
    propertyId: e.houseId ?? e.studioId ?? "",
    propertyType: e.propertyType === PropertyType.LAND ? "land" : (e.propertyType === PropertyType.HOUSE ? "house" : "studio"),
    propertyLabel: e.propertyType === PropertyType.LAND ? "Terrain" : (e.house?.address ?? e.studio?.address ?? "Inconnu"),
    apartmentNumber: e.apartmentNumber ?? "",
    category: e.category,
    amount: money(e.amount),
    comment: e.comment ?? "",
    date: e.date.toISOString(),
    comments: e.comments.map((c) => ({ id: c.id, content: c.content, author: c.createdBy.username, createdAt: c.createdAt.toISOString() })),
  }));
  return res.json({ houses, studios, payments: paymentDto, expenses: expenseDto });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
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
