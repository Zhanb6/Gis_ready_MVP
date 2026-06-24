const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildSql } = require("./tools/postgres_store_sql");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DB_SCHEMA_FILE = path.join(ROOT, "db", "migrations", "001_schema.sql");
const DATABASE_URL = process.env.DATABASE_URL || "";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 150000);
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Almaty";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

const sessions = new Map();
const loginAttempts = new Map();
let pgPool = null;
let sharedDataVersion = Date.now();
let mutationQueue = Promise.resolve();

const roles = {
  admin: "Администратор",
  initiator: "Военная Часть",
  operator: "Региональный комитет",
  verifier: "Виды/ Рода войск",
  execution: "ГШ"
};

const statuses = {
  draft: "Черновик",
  operator_review: "На проверке (Оператор)",
  verifier_review: "На верификации (Верификатор)",
  execution_review: "На утверждении (Отдел исполнения)",
  approved: "Утверждена",
  included_monthly_plan: "В плане",
  approved_readonly: "Утверждён (read-only)",
  returned_initiator: "Возвращена инициатору",
  returned_operator: "Возвращена оператору",
  returned_verifier: "Возвращена верификатору",
  merged: "Объединена",
  rejected: "Отклонена"
};

const transportLabels = {
  aviation: "Авиа",
  rail: "ЖД",
  auto: "Авто"
};

const bootstrapUserDefinitions = [
  { id: "u0", usernameEnv: "BOOTSTRAP_ADMIN_USERNAME", passwordEnv: "BOOTSTRAP_ADMIN_PASSWORD", usernameFallback: "admin", role: "admin", name: "Администратор системы", unit: "Администрирование" },
  { id: "u1", usernameEnv: "BOOTSTRAP_INITIATOR_USERNAME", passwordEnv: "BOOTSTRAP_INITIATOR_PASSWORD", usernameFallback: "initiator", role: "initiator", name: "Инициатор / Офицер части", unit: "Часть A" },
  { id: "u2", usernameEnv: "BOOTSTRAP_OPERATOR_USERNAME", passwordEnv: "BOOTSTRAP_OPERATOR_PASSWORD", usernameFallback: "operator", role: "operator", name: "Оператор части", unit: "Часть A" },
  { id: "u3", usernameEnv: "BOOTSTRAP_VERIFIER_USERNAME", passwordEnv: "BOOTSTRAP_VERIFIER_PASSWORD", usernameFallback: "verifier", role: "verifier", name: "Верификатор главного корпуса", unit: "Главный корпус" },
  { id: "u4", usernameEnv: "BOOTSTRAP_EXECUTION_USERNAME", passwordEnv: "BOOTSTRAP_EXECUTION_PASSWORD", usernameFallback: "execution", role: "execution", name: "Отдел исполнения", unit: "Отдел исполнения" }
];

function isPasswordHash(value) {
  return /^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(String(value || ""));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function verifyPassword(password, storedHash) {
  if (!isPasswordHash(storedHash)) return false;
  const [, saltValue, hashValue] = storedHash.split("$");
  const expected = Buffer.from(hashValue, "base64url");
  const actual = crypto.scryptSync(String(password), Buffer.from(saltValue, "base64url"), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function passwordPolicyError(password) {
  const value = String(password || "");
  if (value.length < 12) return "Пароль должен содержать не менее 12 символов.";
  if (!/[a-zа-я]/i.test(value) || !/\d/.test(value)) return "Пароль должен содержать буквы и цифры.";
  return "";
}

function usernamePolicyError(username) {
  const value = String(username || "");
  return /^[A-Za-z0-9._-]{3,64}$/.test(value) ? "" : "Логин должен содержать от 3 до 64 латинских букв, цифр или символов . _ -.";
}

function configuredBootstrapUsers(hashPasswords = true) {
  return bootstrapUserDefinitions.map((definition) => ({
    id: definition.id,
    username: String(process.env[definition.usernameEnv] || definition.usernameFallback).trim(),
    passwordHash: hashPasswords ? hashPassword(process.env[definition.passwordEnv] || "") : "",
    role: definition.role,
    name: definition.name,
    unit: definition.unit
  }));
}

function validateSecurityConfig() {
  const missing = [];
  if (!DATABASE_URL) missing.push("DATABASE_URL");
  bootstrapUserDefinitions.forEach((definition) => {
    const username = String(process.env[definition.usernameEnv] || definition.usernameFallback).trim();
    if (usernamePolicyError(username)) throw new Error(`${definition.usernameEnv}: ${usernamePolicyError(username)}`);
    const password = process.env[definition.passwordEnv];
    if (!password) missing.push(definition.passwordEnv);
    else if (passwordPolicyError(password)) throw new Error(`${definition.passwordEnv}: ${passwordPolicyError(password)}`);
  });
  if (missing.length) throw new Error(`Не заданы обязательные переменные окружения: ${missing.join(", ")}. Запустите: node tools/generate_env.js`);
}

const dummyPasswordHash = hashPassword("invalid-password-value");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const mvpCoordinates = {
  auto: {
    "Часть A": [51.16, 71.47],
    "Склад Север": [53.22, 69.39],
    "Склад Юг": [42.34, 69.59],
    "Главный корпус": [51.18, 71.43],
    "Полигон Восток": [49.95, 82.62],
    "Узел Запад": [50.28, 57.21]
  },
  rail: {
    "Станция Астана": [51.16, 71.47],
    "Станция Алматы": [43.24, 76.88],
    "Станция Шымкент": [42.34, 69.59],
    "Станция Караганда": [49.80, 73.10],
    "Станция Актобе": [50.28, 57.21]
  },
  aviation: {
    "Аэродром Астана": [51.03, 71.47],
    "Аэродром Алматы": [43.35, 77.04],
    "Аэродром Шымкент": [42.36, 69.48],
    "Аэродром Караганда": [49.67, 73.33],
    "Аэродром Актобе": [50.25, 57.21],
    "Аэродром Актау": [43.86, 51.09],
    "Аэродром Усть-Каменогорск": [50.04, 82.49],
    "Аэродром Костанай": [53.21, 63.55],
    "Аэродром Тараз": [42.85, 71.30],
    "Аэродром Кызылорда": [44.71, 65.59]
  }
};

function refName(item) {
  return typeof item === "string" ? item : item.name || item.type || item.code || "";
}

function haversineKm(first, second) {
  const toRad = (value) => value * Math.PI / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(second[0] - first[0]);
  const dLon = toRad(second[1] - first[1]);
  const lat1 = toRad(first[0]);
  const lat2 = toRad(second[0]);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(a));
}

function estimateDistanceKm(from, to, type) {
  const coords = mvpCoordinates[type] || {};
  const first = coords[from];
  const second = coords[to];
  if (!first || !second) return 100;
  const factor = type === "aviation" ? 1.02 : type === "rail" ? 1.28 : 1.35;
  return Math.max(30, Math.round(haversineKm(first, second) * factor / 10) * 10);
}

function completeDistanceMatrix(refs) {
  const distances = Array.isArray(refs.distances) ? [...refs.distances] : [];
  const keys = new Set(distances.map((item) => `${item.from}|${item.to}|${item.type}`));
  const addPairs = (items, type) => {
    const names = items.map(refName).filter(Boolean);
    names.forEach((from) => {
      names.forEach((to) => {
        if (from === to) return;
        const key = `${from}|${to}|${type}`;
        if (keys.has(key)) return;
        keys.add(key);
        distances.push({
          from,
          to,
          km: estimateDistanceKm(from, to, type),
          type,
          source: ""
        });
      });
    });
  };
  addPairs(refs.points || [], "auto");
  addPairs(refs.stations || [], "rail");
  addPairs(refs.airfields || [], "aviation");
  return distances;
}

function ensureCompleteDistanceMatrix(refs) {
  const before = Array.isArray(refs.distances) ? refs.distances.length : 0;
  refs.distances = completeDistanceMatrix(refs);
  return refs.distances.length !== before;
}

function seedStore(hashBootstrapPasswords = true) {
  const now = new Date().toISOString();
  const store = {
    meta: {
      version: 1,
      seededAt: now,
      note: "Локальные исходные данные."
    },
    users: configuredBootstrapUsers(hashBootstrapPasswords),
    refs: {
      urgency: ["Критическая", "Высокая", "Средняя", "Несрочная"],
      transportTypes: ["aviation", "rail", "auto"],
      airfields: [
        { code: "TSE", name: "Аэродром Астана", city: "Астана" },
        { code: "ALA", name: "Аэродром Алматы", city: "Алматы" },
        { code: "CIT", name: "Аэродром Шымкент", city: "Шымкент" },
        { code: "KGF", name: "Аэродром Караганда", city: "Караганда" },
        { code: "AKX", name: "Аэродром Актобе", city: "Актобе" },
        { code: "SCO", name: "Аэродром Актау", city: "Актау" },
        { code: "UKK", name: "Аэродром Усть-Каменогорск", city: "Усть-Каменогорск" },
        { code: "KSN", name: "Аэродром Костанай", city: "Костанай" },
        { code: "DMB", name: "Аэродром Тараз", city: "Тараз" },
        { code: "KZO", name: "Аэродром Кызылорда", city: "Кызылорда" }
      ],
      stations: ["Станция Астана", "Станция Алматы", "Станция Шымкент", "Станция Караганда", "Станция Актобе"],
      points: [
        { code: "UNIT-A", name: "Часть A", region: "Центр" },
        { code: "WH-N", name: "Склад Север", region: "Север" },
        { code: "WH-S", name: "Склад Юг", region: "Юг" },
        { code: "HQ", name: "Главный корпус", region: "Центр" },
        { code: "POL-E", name: "Полигон Восток", region: "Восток" },
        { code: "NODE-W", name: "Узел Запад", region: "Запад" }
      ],
      vehicleTypes: [
        { type: "Автомобиль", capacityKg: 10000, units: 8 },
        { type: "тентованный грузовик", capacityKg: 8000, units: 4 },
        { type: "бортовой грузовик", capacityKg: 7000, units: 5 },
        { type: "рефрижератор", capacityKg: 5000, units: 2 },
        { type: "спецтехника", capacityKg: 12000, units: 1 }
      ],
      tariffs: [
        { id: "t1", transportType: "aviation", pricePerKm: 1200, daysBase: 1, note: "" },
        { id: "t2", transportType: "rail", pricePerKm: 250, daysBase: 5, note: "" },
        { id: "t3", transportType: "auto", pricePerKm: 450, daysBase: 2, note: "" }
      ],
      distances: [
        { from: "Часть A", to: "Склад Север", km: 420, type: "auto", source: "" },
        { from: "Склад Север", to: "Часть A", km: 420, type: "auto", source: "" },
        { from: "Часть A", to: "Склад Юг", km: 760, type: "auto", source: "" },
        { from: "Склад Юг", to: "Часть A", km: 760, type: "auto", source: "" },
        { from: "Главный корпус", to: "Полигон Восток", km: 510, type: "auto", source: "" },
        { from: "Полигон Восток", to: "Главный корпус", km: 510, type: "auto", source: "" },
        { from: "Аэродром Астана", to: "Аэродром Алматы", km: 970, type: "aviation", source: "" },
        { from: "Аэродром Алматы", to: "Аэродром Астана", km: 970, type: "aviation", source: "" },
        { from: "Станция Астана", to: "Станция Алматы", km: 1210, type: "rail", source: "" },
        { from: "Станция Алматы", to: "Станция Астана", km: 1210, type: "rail", source: "" }
      ],
      scheduleConfig: {
        requestDeadlineDay: 20,
        autoPlanDay: 21,
        planLockDay: 25,
        weekendPolicy: "next_working_day",
        note: "Логика дат хранится в конфиге."
      }
    },
    applications: [],
    monthlyPlans: [],
    notifications: []
  };
  store.refs.distances = completeDistanceMatrix(store.refs);
  return store;
}

function getPgPool() {
  if (!pgPool) {
    const { Pool } = require("pg");
    pgPool = new Pool({ connectionString: DATABASE_URL });
  }
  return pgPool;
}

function toIsoTimestamp(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toIsoDate(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function numericValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readPostgresStore() {
  const db = getPgPool();
  const [
    metaResult,
    usersResult,
    urgencyResult,
    transportResult,
    airfieldsResult,
    stationsResult,
    pointsResult,
    wagonTypesResult,
    truckTypesResult,
    tariffsResult,
    distancesResult,
    vehicleTypesResult,
    scheduleResult,
    applicationsResult,
    appLogsResult,
    plansResult,
    planEntriesResult,
    planLogsResult,
    notificationsResult
  ] = await Promise.all([
    db.query("select value from app_meta where key = 'meta'"),
    db.query("select * from users order by id"),
    db.query("select name from ref_urgency order by sort_order, name"),
    db.query("select code from ref_transport_types order by code"),
    db.query("select code, name, city from ref_airfields order by code"),
    db.query("select name from ref_stations order by name"),
    db.query("select code, name, region from ref_points order by code"),
    db.query("select name from ref_wagon_types order by name"),
    db.query("select name from ref_truck_types order by name"),
    db.query("select id, transport_type, price_per_km, days_base, note from ref_tariffs order by id"),
    db.query("select from_point, to_point, transport_type, km, source from ref_distances order by transport_type, from_point, to_point"),
    db.query("select type, capacity_kg, units from ref_vehicle_types order by type"),
    db.query("select * from schedule_config limit 1"),
    db.query("select * from applications order by length(id), id"),
    db.query("select * from application_logs order by at, id"),
    db.query("select * from monthly_plans order by month"),
    db.query("select * from monthly_plan_entries order by plan_id, id"),
    db.query("select * from monthly_plan_logs order by at, id"),
    db.query("select * from notifications order by created_at, id")
  ]);

  const appLogsById = new Map();
  appLogsResult.rows.forEach((row) => {
    if (!appLogsById.has(row.application_id)) appLogsById.set(row.application_id, []);
    appLogsById.get(row.application_id).push({
      at: toIsoTimestamp(row.at),
      userId: row.user_id || "",
      userName: row.user_name || "",
      role: row.role || "",
      action: row.action || "",
      fromStatus: row.from_status || "",
      toStatus: row.to_status || "",
      comment: row.comment || ""
    });
  });

  const planEntriesById = new Map();
  planEntriesResult.rows.forEach((row) => {
    if (!planEntriesById.has(row.plan_id)) planEntriesById.set(row.plan_id, []);
    const payload = row.payload || {};
    planEntriesById.get(row.plan_id).push({
      ...payload,
      applicationId: row.application_id || payload.applicationId || "",
      date: toIsoDate(row.date) || payload.date || "",
      route: row.route || payload.route || "",
      transportType: row.transport_type || payload.transportType || "",
      cargoName: row.cargo_name || payload.cargoName || "",
      weightKg: numericValue(row.weight_kg || payload.weightKg),
      trips: numericValue(row.trips || payload.trips) || 1,
      distanceKm: numericValue(row.distance_km || payload.distanceKm),
      motorResourceKm: numericValue(row.motor_resource_km || payload.motorResourceKm),
      cost: numericValue(row.cost || payload.cost)
    });
  });

  const planLogsById = new Map();
  planLogsResult.rows.forEach((row) => {
    if (!planLogsById.has(row.plan_id)) planLogsById.set(row.plan_id, []);
    planLogsById.get(row.plan_id).push({
      at: toIsoTimestamp(row.at),
      userId: row.user_id || "",
      userName: row.user_name || "",
      role: row.role || "",
      action: row.action || "",
      comment: row.comment || ""
    });
  });

  const schedule = scheduleResult.rows[0] || {};
  const store = {
    meta: metaResult.rows[0]?.value || {},
    users: usersResult.rows.map((row) => ({
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      name: row.name,
      unit: row.unit || ""
    })),
    refs: {
      urgency: urgencyResult.rows.map((row) => row.name),
      transportTypes: transportResult.rows.map((row) => row.code),
      airfields: airfieldsResult.rows.map((row) => ({ code: row.code, name: row.name, city: row.city || "" })),
      stations: stationsResult.rows.map((row) => row.name),
      points: pointsResult.rows.map((row) => ({ code: row.code, name: row.name, region: row.region || "" })),
      wagonTypes: wagonTypesResult.rows.map((row) => row.name),
      truckTypes: truckTypesResult.rows.map((row) => row.name),
      tariffs: tariffsResult.rows.map((row) => ({
        id: row.id,
        transportType: row.transport_type,
        pricePerKm: numericValue(row.price_per_km),
        daysBase: numericValue(row.days_base) || 1,
        note: row.note || ""
      })),
      distances: distancesResult.rows.map((row) => ({
        from: row.from_point,
        to: row.to_point,
        type: row.transport_type,
        km: numericValue(row.km),
        source: row.source || ""
      })),
      vehicleTypes: vehicleTypesResult.rows.map((row) => ({
        type: row.type,
        capacityKg: numericValue(row.capacity_kg),
        units: numericValue(row.units)
      })),
      scheduleConfig: {
        requestDeadlineDay: numericValue(schedule.request_deadline_day) || 20,
        autoPlanDay: numericValue(schedule.auto_plan_day) || 21,
        planLockDay: numericValue(schedule.plan_lock_day) || 25,
        weekendPolicy: schedule.weekend_policy || "next_working_day",
        note: schedule.note || ""
      }
    },
    applications: applicationsResult.rows.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: toIsoTimestamp(row.created_at),
      updatedAt: toIsoTimestamp(row.updated_at),
      createdBy: row.created_by || "",
      unit: row.unit || "",
      transportType: row.transport_type,
      urgency: row.urgency,
      origin: row.origin,
      destination: row.destination,
      plannedDate: toIsoDate(row.planned_date),
      cargoName: row.cargo_name,
      cargoCategory: row.cargo_category || "",
      weightKg: numericValue(row.weight_kg),
      placeWeightKg: numericValue(row.place_weight_kg),
      volumeM3: numericValue(row.volume_m3),
      places: numericValue(row.places),
      dimensions: row.dimensions || "",
      sender: row.sender || "",
      recipient: row.recipient || "",
      justification: row.justification || "",
      comment: row.comment || "",
      linkedReturnApplicationId: row.linked_return_application_id || "",
      auto: row.auto || {},
      rail: row.rail || {},
      aviation: row.aviation || {},
      calculation: row.calculation || {},
      log: appLogsById.get(row.id) || []
    })),
    monthlyPlans: plansResult.rows.map((row) => {
      const payload = row.payload || {};
      return {
        ...payload,
        id: row.id,
        month: row.month,
        status: row.status,
        generatedAt: toIsoTimestamp(row.generated_at),
        lockedAt: toIsoTimestamp(row.locked_at),
        entries: planEntriesById.get(row.id) || payload.entries || [],
        log: planLogsById.get(row.id) || payload.log || []
      };
    }),
    notifications: notificationsResult.rows.map((row) => ({
      at: toIsoTimestamp(row.created_at),
      message: row.message,
      ...(row.payload || {})
    }))
  };

  return migrateStore(store);
}

async function readStore() {
  return readPostgresStore();
}

async function writeStore(store) {
  await getPgPool().query(buildSql(store));
  sharedDataVersion += 1;
}

async function secureStoredUsers(db) {
  const result = await db.query("select id, password_hash from users");
  for (const row of result.rows) {
    if (!isPasswordHash(row.password_hash)) {
      await db.query("update users set password_hash = $1, updated_at = now() where id = $2", [hashPassword(row.password_hash || ""), row.id]);
    }
  }
}

async function applyBootstrapCredentials(db) {
  for (const definition of bootstrapUserDefinitions) {
    const username = String(process.env[definition.usernameEnv] || definition.usernameFallback).trim();
    const password = process.env[definition.passwordEnv];
    await db.query(
      "update users set username = $1, password_hash = $2, updated_at = now() where id = $3",
      [username, hashPassword(password), definition.id]
    );
  }
}

function enqueueMutation(task) {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.catch(() => {});
  return result;
}

async function initializePostgres() {
  const db = getPgPool();
  const schemaSql = fs.readFileSync(DB_SCHEMA_FILE, "utf8");
  await db.query(schemaSql);
  const result = await db.query("select count(*)::integer as count from users");
  if (Number(result.rows[0]?.count || 0) === 0) {
    await db.query(buildSql(seedStore()));
    sharedDataVersion += 1;
  }
  await secureStoredUsers(db);
  await applyBootstrapCredentials(db);
}

function migrateStore(store) {
  const fresh = seedStore(false);

  if (!store.meta) {
    store.meta = fresh.meta;
  }
  if (store.meta.version !== 2) {
    store.meta.version = 2;
    store.meta.updatedAt = new Date().toISOString();
  }
  if (!store.users.some((user) => user.role === "admin")) {
    store.users.unshift(configuredBootstrapUsers()[0]);
  }
  store.users.forEach((user) => {
    if (!isPasswordHash(user.passwordHash)) user.passwordHash = hashPassword(user.passwordHash || "");
    if (!roles[user.role]) {
      user.role = "initiator";
    }
  });

  store.refs = store.refs || {};
  for (const [key, value] of Object.entries(fresh.refs)) {
    if (!store.refs[key]) {
      store.refs[key] = value;
    }
  }
  if (Array.isArray(store.refs.airfields) && typeof store.refs.airfields[0] === "string") {
    store.refs.airfields = fresh.refs.airfields;
  }
  if (Array.isArray(store.refs.points) && typeof store.refs.points[0] === "string") {
    store.refs.points = fresh.refs.points;
  }
  if (!store.refs.vehicleTypes) {
    store.refs.vehicleTypes = fresh.refs.vehicleTypes;
  }
  store.refs.vehicleTypes.forEach((item) => {
    if (item.type === "КамАЗ") item.type = "Автомобиль";
  });
  if (!store.refs.scheduleConfig) {
    store.refs.scheduleConfig = fresh.refs.scheduleConfig;
  }
  if (store.refs.tariffs.some((tariff) => tariff.pricePerKm === undefined)) {
    store.refs.tariffs = fresh.refs.tariffs;
  }
  ensureCompleteDistanceMatrix(store.refs);

  const statusMap = {
    submitted_operator: "operator_review",
    approved_verifier: "execution_review",
    final_approved: "execution_review"
  };
  store.applications = store.applications || [];
  store.applications.forEach((app) => {
    if (statusMap[app.status]) {
      app.status = statusMap[app.status];
    }
    if (!statuses[app.status]) {
      app.status = "draft";
    }
    if (app.auto?.truckType === "КамАЗ") app.auto.truckType = "Автомобиль";
  });
  store.monthlyPlans = store.monthlyPlans || [];
  store.notifications = store.notifications || [];

  return store;
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

function send(res, status, data, headers = {}) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return Object.fromEntries(raw.split(";").filter(Boolean).map((part) => {
    const [key, ...rest] = part.trim().split("=");
    return [key, decodeURIComponent(rest.join("="))];
  }));
}

function currentUser(req, store) {
  const sid = parseCookies(req).sid;
  if (!sid || !sessions.has(sid)) return null;
  const session = sessions.get(sid);
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  session.lastSeenAt = Date.now();
  return store.users.find((user) => user.id === session.userId) || null;
}

function requireUser(req, res, store) {
  const user = currentUser(req, store);
  if (!user) {
    send(res, 401, { error: "Требуется вход в систему." });
    return null;
  }
  return user;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "Размер запроса превышает допустимые 2 МБ.");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Некорректный формат JSON.");
  }
}

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function loginAttemptKey(req, username) {
  return `${requestIp(req)}|${String(username || "").toLowerCase()}`;
}

function activeLoginBlock(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return false;
  const now = Date.now();
  if (attempt.blockedUntil && attempt.blockedUntil > now) return true;
  if (now - attempt.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  return false;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  const attempt = !current || now - current.firstAt > LOGIN_WINDOW_MS ? { count: 0, firstAt: now, blockedUntil: 0 } : current;
  attempt.count += 1;
  if (attempt.count >= MAX_LOGIN_FAILURES) attempt.blockedUntil = now + LOGIN_BLOCK_MS;
  loginAttempts.set(key, attempt);
}

function sessionCookie(sid, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = COOKIE_SECURE ? "; Secure" : "";
  return `sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function pruneSecurityState() {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(sid);
  }
  for (const [key, attempt] of loginAttempts) {
    if ((!attempt.blockedUntil || attempt.blockedUntil <= now) && now - attempt.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}

function safeUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role, roleLabel: roles[user.role], name: user.name, unit: user.unit };
}

function nextApplicationId(store) {
  const max = store.applications.reduce((acc, app) => {
    const id = String(app.id);
    const n = /^[1-9]\d{0,3}$/.test(id) ? Number(id) : NaN;
    return Number.isFinite(n) ? Math.max(acc, n) : acc;
  }, 0);
  return max < 9999 ? String(max + 1) : "";
}

function nextUserId(store) {
  const max = store.users.reduce((acc, user) => {
    const n = Number(String(user.id).replace("u", ""));
    return Number.isFinite(n) ? Math.max(acc, n) : acc;
  }, 0);
  return `u${max + 1}`;
}

function addLog(app, user, action, comment = "", fromStatus = app.status, toStatus = app.status) {
  app.log = app.log || [];
  app.log.push({
    at: new Date().toISOString(),
    userId: user.id,
    userName: user.name,
    role: user.role,
    action,
    fromStatus,
    toStatus,
    comment
  });
}

function distanceFor(store, app) {
  for (let i = store.refs.distances.length - 1; i >= 0; i -= 1) {
    const item = store.refs.distances[i];
    if (item.from === app.origin && item.to === app.destination && item.type === app.transportType) return item;
  }
  return null;
}

function missingDistanceMessage(app) {
  const origin = app.origin || "точка А не выбрана";
  const destination = app.destination || "точка Б не выбрана";
  const transport = transportLabels[app.transportType] || "тип транспорта не выбран";
  return `Для маршрута "${origin} -> ${destination}" (${transport}) не задано расстояние в справочнике. Черновик можно сохранить, но отправка дальше заблокирована до заполнения матрицы расстояний.`;
}

function refValues(values = []) {
  return values.map((item) => typeof item === "string" ? item : item.name || item.type || item.code || "");
}

function isKnownParty(store, value) {
  return refValues(store.refs.points).includes(value);
}

function recommendTransport(app) {
  const weight = Number(app.weightKg || 0);
  if (app.urgency === "Критическая" && weight > 0 && weight <= 10000) {
    return { transportType: "aviation", activeTypes: ["aviation"], label: "Авиа", reason: "Для критической срочности и веса до 10 тонн обязательно выбрать авиа." };
  }
  if (app.urgency === "Несрочная" && weight > 10000) {
    return { transportType: "rail", activeTypes: ["rail"], label: "ЖД", reason: "Рекомендуется ЖД для объемного груза." };
  }
  if (app.urgency === "Средняя" && weight > 0 && weight <= 10000) {
    return { transportType: "auto", activeTypes: ["auto"], label: "Авто", reason: "Обязательно выбрать автомобильный транспорт." };
  }
  if (app.urgency === "Высокая" && weight > 0 && weight <= 10000) {
    return { transportType: "", activeTypes: ["aviation", "auto"], label: "Авиа / Авто", reason: "Допустим авиационный или автомобильный транспорт." };
  }
  return { transportType: "", activeTypes: [], label: "Не определено", reason: "По правилам MVP рекомендация для этих параметров не определена." };
}

function mandatoryTransportError(app) {
  const recommendation = recommendTransport(app);
  const activeTypes = recommendation.activeTypes || (recommendation.transportType ? [recommendation.transportType] : []);
  if (!app.transportType || !activeTypes.length || activeTypes.includes(app.transportType)) return "";
  return `Для выбранной срочности и веса обязателен тип перевозки: ${recommendation.label}.`;
}

function calculate(store, app) {
  const tariff = store.refs.tariffs.find((item) => item.transportType === app.transportType);
  const distance = distanceFor(store, app);
  const km = distance ? Number(distance.km) : 0;
  const weight = Number(app.weightKg || 0);
  if (!tariff) {
    return { error: "Для выбранного транспорта не задан тариф." };
  }
  if (!distance) {
    return { error: missingDistanceMessage(app) };
  }
  const trips = Number(app.auto?.trips || 1);
  const vehicles = Number(app.auto?.vehicleCount || 1);
  const multiplier = app.transportType === "auto" ? Math.max(1, trips * vehicles) : 1;
  const cost = Math.round(km * Number(tariff.pricePerKm || 0) * multiplier);
  const estimatedDays = Math.max(1, Number(tariff.daysBase || 1) + Math.ceil(km / (app.transportType === "aviation" ? 1500 : app.transportType === "rail" ? 900 : 650)));
  return {
    distanceKm: km,
    preliminaryCost: cost,
    estimatedDays,
    recommendation: recommendTransport(app)
  };
}

function validateApplication(store, app, options = {}) {
  const requireDistance = Boolean(options.requireDistance);
  const errors = [];
  const required = ["transportType", "origin", "destination", "plannedDate", "cargoName", "sender", "recipient"];
  if (app.transportType !== "aviation") required.push("urgency", "weightKg", "places");
  required.forEach((field) => {
    if (app[field] === undefined || app[field] === null || app[field] === "") errors.push(`Поле "${field}" обязательно.`);
  });
  if (!transportLabels[app.transportType]) errors.push("Выберите корректный тип перевозки.");
  if (app.transportType !== "aviation" && !store.refs.urgency.includes(app.urgency)) errors.push("Выберите корректную срочность.");
  if (app.origin && app.destination && app.origin === app.destination) errors.push("Точка А и точка Б не могут совпадать.");
  if (app.sender && !isKnownParty(store, app.sender)) errors.push("Отправитель должен быть выбран из локального справочника.");
  if (app.recipient && !isKnownParty(store, app.recipient)) errors.push("Получатель должен быть выбран из локального справочника.");
  if (app.plannedDate) validateNotPastDate(app.plannedDate, "Планируемая дата", errors);
  if (app.plannedDate && isRequestDeadlinePassed(store, app.plannedDate)) {
    errors.push("Приём заявок на текущий месяц закрыт. Следующий цикл — с 1-го числа.");
  }
  if (app.transportType !== "aviation" && Number(app.weightKg || 0) <= 0) errors.push("Вес должен быть больше 0.");
  if (app.placeWeightKg && Number(app.placeWeightKg) < 0) errors.push("Вес одного места не может быть отрицательным.");
  if (app.transportType !== "aviation" && Number(app.places || 0) <= 0) errors.push("Количество мест должно быть больше 0.");
  if (app.dimensions && !parseDimensions(app.dimensions)) errors.push("Габариты должны быть в формате Д x Ш x В.");
  const transportRuleError = mandatoryTransportError(app);
  if (transportRuleError) errors.push(transportRuleError);
  if (requireDistance && app.origin && app.destination && app.transportType && !distanceFor(store, app)) {
    errors.push(missingDistanceMessage(app));
  }

  if (app.transportType === "aviation") {
    const av = app.aviation || {};
    ["airfieldFrom", "airfieldTo", "flightDate", "airJustification"].forEach((field) => {
      if (!av[field]) errors.push(`Авиа-поле "${field}" обязательно.`);
    });
    if (av.airfieldFrom && av.airfieldTo && av.airfieldFrom === av.airfieldTo) errors.push("Аэродром отправления и назначения не могут совпадать.");
    if (av.flightDate) validateNotPastDate(av.flightDate, "Дата вылета", errors);
    const cargoWeight = String(av.cargoWeightKg || "").trim();
    const normalizedCargoWeight = Number(cargoWeight.replace(",", "."));
    if (cargoWeight && cargoWeight !== "-" && (!Number.isFinite(normalizedCargoWeight) || normalizedCargoWeight <= 0)) {
      errors.push("В поле веса груза укажите положительное число или символ -.");
    }
    if (av.oversizedCargo) {
      const exactDimensions = parseDimensions(av.exactDimensions || "");
      if (Number(av.exactWeightKg || 0) <= 100) errors.push("Вес груза должен быть больше 100 кг.");
      if (!exactDimensions) {
        errors.push("Укажите габариты груза: длину, ширину и высоту.");
      } else if (exactDimensions[0] <= 150 && exactDimensions[1] <= 120 && exactDimensions[2] <= 70) {
        errors.push("Хотя бы один габарит груза должен превышать 150 x 120 x 70 см.");
      }
    }
  }

  if (app.transportType === "rail") {
    const rail = app.rail || {};
    if (!rail.stationFrom || !rail.stationTo || !rail.departureDate) errors.push("Для ЖД-заявки обязательны станции отправления/назначения и дата отправки.");
    if (rail.stationFrom && rail.stationTo && rail.stationFrom === rail.stationTo) errors.push("Станция отправления и назначения не могут совпадать.");
    if (rail.departureDate) validateNotPastDate(rail.departureDate, "Дата отправки", errors);
    const minimumDepartureDate = minimumRailDepartureDate(app);
    if (rail.departureDate && rail.departureDate < minimumDepartureDate) {
      errors.push(`Дата отправки для ЖД должна быть не раньше ${minimumDepartureDate} — через 3 дня после подачи заявки.`);
    }
    if (!rail.wagonNumber) errors.push("Для ЖД-заявки обязательны транспортные средства.");
  }

  if (app.transportType === "auto") {
    const auto = app.auto || {};
    if (!auto.vehicleCount || !auto.trips) errors.push("Для заявки «Авто» обязательны количество машин и количество машино-рейсов.");
    if (auto.departureDate) validateNotPastDate(auto.departureDate, "Дата выезда", errors);
    if (auto.transportEndDate) validateNotPastDate(auto.transportEndDate, "Конечная дата перевозки", errors);
    if (auto.transportEndDate && app.plannedDate && auto.transportEndDate < app.plannedDate) errors.push("Конечная дата перевозки не может быть раньше даты выезда.");
  }

  return errors;
}

function todayLocalIso() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function localIsoDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function addDaysIso(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function minimumRailDepartureDate(app) {
  const baseDate = app.createdAt ? localIsoDate(new Date(app.createdAt)) : todayLocalIso();
  return addDaysIso(baseDate, 3);
}

function validateNotPastDate(value, label, errors) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    errors.push(`${label} должна быть в формате YYYY-MM-DD.`);
    return;
  }
  if (value < todayLocalIso()) {
    errors.push(`${label} не может быть раньше сегодняшней даты.`);
  }
}

function isRequestDeadlinePassed(store, plannedDate) {
  const now = todayLocalIso();
  const month = monthKey(plannedDate);
  if (month !== monthKey(new Date())) return false;
  return now > effectiveConfigDate(store, month, "requestDeadlineDay");
}

function parseDimensions(value) {
  const tokens = String(value).replace(/[,]/g, ".").replace(/[xх×]/gi, "x").split("x").map((part) => part.trim());
  if (tokens.length !== 3 || tokens.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  const parts = tokens.map((part) => Number(part));
  if (parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return parts;
}

function normalizeAppPayload(payload, user, existing = {}) {
  const hasPayload = (key) => Object.prototype.hasOwnProperty.call(payload, key);
  const textValue = (key, current = "", fallback = "") => hasPayload(key) ? String(payload[key] ?? "") : String(current ?? fallback);
  const numberValue = (key, current = 0) => Number(hasPayload(key) ? payload[key] || 0 : current || 0);
  const transportType = payload.transportType || existing.transportType || "";
  const origin = transportType === "aviation" ? payload.airfieldFrom || payload.origin : transportType === "rail" ? payload.stationFrom || payload.origin : payload.origin;
  const destination = transportType === "aviation" ? payload.airfieldTo || payload.destination : transportType === "rail" ? payload.stationTo || payload.destination : payload.destination;
  const hasReturnCargo = hasPayload("hasReturnCargo")
    ? payload.hasReturnCargo === true || payload.hasReturnCargo === "1"
    : Boolean(existing.auto?.hasReturnCargo);
  const oversizedCargo = hasPayload("oversizedCargo")
    ? payload.oversizedCargo === true || payload.oversizedCargo === "1"
    : Boolean(existing.aviation?.oversizedCargo);
  return {
    ...existing,
    unit: textValue("unit", existing.unit, user.unit),
    transportType,
    urgency: textValue("urgency", existing.urgency, transportType === "aviation" ? "Средняя" : "") || (transportType === "aviation" ? "Средняя" : ""),
    origin: origin || existing.origin || "",
    destination: destination || existing.destination || "",
    plannedDate: payload.plannedDate || payload.flightDate || payload.departureDate || existing.plannedDate || "",
    cargoName: textValue("cargoName", existing.cargoName),
    cargoCategory: textValue("cargoCategory", existing.cargoCategory),
    weightKg: numberValue("weightKg", existing.weightKg),
    placeWeightKg: numberValue("placeWeightKg", existing.placeWeightKg),
    volumeM3: numberValue("volumeM3", existing.volumeM3),
    places: numberValue("places", existing.places),
    dimensions: textValue("dimensions", existing.dimensions),
    sender: textValue("sender", existing.sender),
    recipient: textValue("recipient", existing.recipient),
    justification: textValue("justification", existing.justification),
    comment: textValue("comment", existing.comment),
    aviation: {
      ...(existing.aviation || {}),
      airfieldFrom: payload.airfieldFrom || payload.origin || existing.aviation?.airfieldFrom || "",
      airfieldTo: payload.airfieldTo || payload.destination || existing.aviation?.airfieldTo || "",
      flightDate: payload.flightDate || payload.plannedDate || existing.aviation?.flightDate || "",
      aircraftType: textValue("aircraftType", existing.aviation?.aircraftType),
      requestFor: textValue("requestFor", existing.aviation?.requestFor),
      personnel: textValue("personnel", existing.aviation?.personnel),
      cargoWeightKg: textValue("aviationCargoWeightKg", existing.aviation?.cargoWeightKg),
      oversizedCargo,
      airJustification: hasPayload("airJustification") ? textValue("airJustification") : hasPayload("justification") ? textValue("justification") : existing.aviation?.airJustification || "",
      exactWeightKg: oversizedCargo ? textValue("exactWeightKg", existing.aviation?.exactWeightKg) : "",
      exactDimensions: oversizedCargo ? textValue("exactDimensions", existing.aviation?.exactDimensions) : ""
    },
    rail: {
      ...(existing.rail || {}),
      stationFrom: payload.stationFrom || payload.origin || existing.rail?.stationFrom || "",
      stationTo: payload.stationTo || payload.destination || existing.rail?.stationTo || "",
      departureDate: payload.departureDate || payload.plannedDate || existing.rail?.departureDate || "",
      wagonNumber: textValue("wagonNumber", existing.rail?.wagonNumber),
      militaryEchelonNumber: textValue("militaryEchelonNumber", existing.rail?.militaryEchelonNumber),
      unNumber: textValue("unNumber", existing.rail?.unNumber),
      emergencyCardNumber: textValue("emergencyCardNumber", existing.rail?.emergencyCardNumber),
      oversizeDegree: textValue("oversizeDegree", existing.rail?.oversizeDegree),
      personnelByCategory: textValue("personnelByCategory", existing.rail?.personnelByCategory),
      fasteningMaterial: textValue("fasteningMaterial", existing.rail?.fasteningMaterial),
      echelonChiefDetails: textValue("echelonChiefDetails", existing.rail?.echelonChiefDetails),
      railNote: textValue("railNote", existing.rail?.railNote),
      loadingRequired: Boolean(payload.loadingRequired || existing.rail?.loadingRequired),
      unloadingRequired: Boolean(payload.unloadingRequired || existing.rail?.unloadingRequired)
    },
    auto: {
      ...(existing.auto || {}),
      truckType: "Автомобиль",
      departureDate: payload.departureDate || payload.plannedDate || existing.auto?.departureDate || "",
      vehicleCount: numberValue("vehicleCount", existing.auto?.vehicleCount),
      trips: numberValue("trips", existing.auto?.trips),
      militaryTransportNumber: textValue("autoMilitaryTransportNumber", existing.auto?.militaryTransportNumber),
      unNumber: textValue("autoUnNumber", existing.auto?.unNumber),
      emergencyCardNumber: textValue("autoEmergencyCardNumber", existing.auto?.emergencyCardNumber),
      oversizeDegree: textValue("autoOversizeDegree", existing.auto?.oversizeDegree),
      personnelByCategory: textValue("autoPersonnelByCategory", existing.auto?.personnelByCategory),
      allocatingUnit: textValue("allocatingUnit", existing.auto?.allocatingUnit),
      fuelTankers: numberValue("fuelTankers", existing.auto?.fuelTankers),
      trailers: numberValue("trailers", existing.auto?.trailers),
      destinationPoints: textValue("autoDestinationPoints", existing.auto?.destinationPoints),
      transportEndDate: textValue("transportEndDate", existing.auto?.transportEndDate),
      fasteningMaterial: textValue("autoFasteningMaterial", existing.auto?.fasteningMaterial),
      chiefDetails: textValue("autoChiefDetails", existing.auto?.chiefDetails),
      autoNote: textValue("autoNote", existing.auto?.autoNote),
      hasReturnCargo,
      returnCargoPlan: hasReturnCargo ? textValue("returnCargoPlan", existing.auto?.returnCargoPlan) : ""
    }
  };
}

function canView(user, app) {
  if (user.role === "admin") return true;
  if (user.role === "initiator") return app.createdBy === user.id && ["draft", "returned_initiator", "rejected"].includes(app.status);
  return ["operator", "verifier", "execution"].includes(user.role);
}

function canEdit(user, app) {
  if (user.role === "admin") return false;
  if (user.role === "initiator") return app.createdBy === user.id && ["draft", "returned_initiator", "rejected"].includes(app.status);
  if (user.role === "verifier") return ["verifier_review", "returned_verifier"].includes(app.status);
  return false;
}

function canDelete(user, app) {
  return user.role === "initiator" && app.createdBy === user.id && ["draft", "rejected"].includes(app.status);
}

function availableActions(user, app) {
  const actions = [];
  if (user.role === "initiator" && app.createdBy === user.id && ["draft", "returned_initiator", "rejected"].includes(app.status)) actions.push("submit");
  if (user.role === "operator" && ["operator_review", "returned_operator"].includes(app.status)) actions.push("send_verifier", "reject");
  if (user.role === "verifier" && ["verifier_review", "returned_verifier"].includes(app.status)) actions.push("approve_verifier", "return_initiator");
  if (user.role === "execution" && app.status === "execution_review") actions.push("approve_execution", "reject");
  return actions;
}

function actionLabel(action) {
  return {
    submit: "Отправить оператору",
    send_verifier: "Отправить верификатору",
    return_initiator: "Вернуть на доработку",
    return_operator: "Вернуть оператору",
    return_verifier: "Вернуть верификатору",
    approve_verifier: "Передать на утверждение",
    approve_execution: "Утвердить",
    reject: "Отклонить"
  }[action] || action;
}

function applyAction(store, app, user, action, comment) {
  if (!availableActions(user, app).includes(action)) {
    return { error: "Действие недоступно для роли или текущего статуса." };
  }
  const needsComment = ["return_initiator", "return_operator", "return_verifier", "reject"].includes(action);
  if (needsComment && !String(comment || "").trim()) {
    return { error: "Для возврата или отклонения обязателен комментарий." };
  }
  const errors = ["submit", "send_verifier", "approve_verifier", "approve_execution"].includes(action) ? validateApplication(store, app, { requireDistance: true }) : [];
  if (errors.length) return { error: errors.join(" ") };

  const from = app.status;
  const transitions = {
    submit: "operator_review",
    send_verifier: "verifier_review",
    return_initiator: "returned_initiator",
    return_operator: "returned_operator",
    return_verifier: "returned_verifier",
    approve_verifier: "execution_review",
    approve_execution: "approved",
    reject: "rejected"
  };
  app.status = transitions[action] || app.status;
  app.updatedAt = new Date().toISOString();
  app.calculation = calculate(store, app);
  addLog(app, user, actionLabel(action), comment, from, app.status);
  if (action === "approve_execution") {
    generateMonthlyPlan(store, user, monthKey(app.plannedDate));
  }
  return { app };
}

function monthKey(date = new Date()) {
  const d = typeof date === "string" ? new Date(date) : date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function aviationTransportLoad(app) {
  if (!app || app.transportType !== "aviation") return "";
  const parts = [];
  if (app.aviation?.personnel) parts.push(`Личный состав: ${app.aviation.personnel}`);
  if (app.aviation?.cargoWeightKg) {
    const weight = String(app.aviation.cargoWeightKg).trim();
    parts.push(weight === "-" ? "Вес груза: -" : `Вес груза: ${weight} кг`);
  }
  return parts.join(" / ");
}

function weightInTons(weightKg) {
  const value = Number(weightKg || 0) / 1000;
  if (!value) return "";
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function autoPlanDetails(app, entry = {}) {
  if (!app || app.transportType !== "auto") return {};
  const trips = Number(app.auto?.trips || entry.trips || 1);
  const distanceKm = Number(entry.distanceKm || 0);
  const cargoDetails = [app.cargoName];
  if (app.places) cargoDetails.push(`${app.places} мест`);
  if (app.weightKg) cargoDetails.push(`${app.weightKg} кг`);
  const dangerousCargoNumbers = [
    app.auto?.unNumber ? `ООН: ${app.auto.unNumber}` : "",
    app.auto?.emergencyCardNumber ? `аварийная карточка: ${app.auto.emergencyCardNumber}` : ""
  ].filter(Boolean).join("; ");
  const transportMeans = [
    app.auto?.vehicleCount ? `автомобилей: ${app.auto.vehicleCount}` : "",
    app.auto?.fuelTankers ? `автотопливоцистерн: ${app.auto.fuelTankers}` : "",
    app.auto?.trailers ? `прицепов: ${app.auto.trailers}` : ""
  ].filter(Boolean).join("; ");
  return {
    applicant: app.sender || app.unit || "",
    cargoAndDestination: [app.cargoName, app.destination].filter(Boolean).join("; "),
    cargoMassTons: weightInTons(app.weightKg),
    allocatingUnit: app.auto?.allocatingUnit || app.sender || "",
    cargoVehicles: app.auto?.vehicleCount || "",
    fuelTankers: app.auto?.fuelTankers || "",
    trailers: app.auto?.trailers || "",
    initialPoint: app.origin || "",
    destinationPoints: app.auto?.destinationPoints || app.destination || "",
    finalPoint: app.destination || "",
    haulDistanceTrips: distanceKm ? `${distanceKm} км / ${trips} рейс.` : `${trips} рейс.`,
    transportStartDate: app.plannedDate || "",
    transportEndDate: app.auto?.transportEndDate || "",
    autoNote: app.auto?.autoNote || app.comment || app.justification || "",
    autoMilitaryTransportNumber: app.auto?.militaryTransportNumber || "",
    autoRequestCargoAndQuantity: cargoDetails.filter(Boolean).join("; "),
    autoDangerousCargoNumbers: dangerousCargoNumbers,
    autoRequestOversizeDegree: app.auto?.oversizeDegree || "",
    autoRequestPersonnel: app.auto?.personnelByCategory || "",
    autoRequestTransportMeans: transportMeans,
    autoLoadingPointSender: [app.origin, app.sender ? `отправитель: ${app.sender}` : ""].filter(Boolean).join("; "),
    autoUnloadingPointRecipient: [app.destination, app.recipient ? `получатель: ${app.recipient}` : ""].filter(Boolean).join("; "),
    autoRequestFasteningMaterial: app.auto?.fasteningMaterial || "",
    autoRequestChiefDetails: app.auto?.chiefDetails || ""
  };
}

function railPlanDetails(app) {
  if (!app || app.transportType !== "rail") return {};
  const cargoDetails = [app.cargoName];
  if (app.places) cargoDetails.push(`${app.places} мест`);
  if (app.weightKg) cargoDetails.push(`${app.weightKg} кг`);
  const dangerousCargoNumbers = [
    app.rail?.unNumber ? `ООН: ${app.rail.unNumber}` : "",
    app.rail?.emergencyCardNumber ? `аварийная карточка: ${app.rail.emergencyCardNumber}` : ""
  ].filter(Boolean).join("; ");
  return {
    militaryEchelonNumber: app.rail?.militaryEchelonNumber || "",
    railCargoAndQuantity: cargoDetails.filter(Boolean).join("; "),
    dangerousCargoNumbers,
    oversizeDegree: app.rail?.oversizeDegree || "",
    personnelByCategory: app.rail?.personnelByCategory || "",
    railTransportMeans: app.rail?.wagonNumber || "",
    loadingPointSender: [app.origin, app.sender ? `отправитель: ${app.sender}` : ""].filter(Boolean).join("; "),
    loadingDate: app.plannedDate || "",
    unloadingPointRecipient: [app.destination, app.recipient ? `получатель: ${app.recipient}` : ""].filter(Boolean).join("; "),
    fasteningMaterial: app.rail?.fasteningMaterial || "",
    echelonChiefDetails: app.rail?.echelonChiefDetails || "",
    railPlanNote: app.rail?.railNote || ""
  };
}

function generateMonthlyPlan(store, user, month = monthKey()) {
  const usedMerged = new Set();
  const entries = store.applications
    .filter((app) => ["approved", "included_monthly_plan", "approved_readonly", "merged"].includes(app.status))
    .filter((app) => monthKey(app.plannedDate) === month)
    .filter((app) => {
      if (app.status !== "merged" || !app.linkedReturnApplicationId) return true;
      const pairKey = [app.id, app.linkedReturnApplicationId].sort().join("_");
      if (usedMerged.has(pairKey)) return false;
      usedMerged.add(pairKey);
      return true;
    })
    .map((app) => {
      const calculation = calculate(store, app);
      const trips = Number(app.auto?.trips || 1);
      const motorResourceKm = app.transportType === "auto" && calculation.distanceKm ? calculation.distanceKm * trips : 0;
      const autoDetails = autoPlanDetails(app, { distanceKm: calculation.distanceKm || 0, trips });
      const railDetails = railPlanDetails(app);
      return {
        applicationId: app.id,
        date: app.plannedDate,
        route: `${app.origin} -> ${app.destination}${app.status === "merged" ? " (двусторонний рейс)" : ""}`,
        transportType: app.transportType,
        cargoName: app.cargoName,
        requestFor: app.transportType === "aviation" ? app.aviation?.requestFor || "" : "",
        aircraftType: app.transportType === "aviation" ? app.aviation?.aircraftType || "" : "",
        flightRoute: app.transportType === "aviation" ? `${app.aviation?.airfieldFrom || app.origin} - ${app.aviation?.airfieldTo || app.destination}` : "",
        personnel: app.transportType === "aviation" ? app.aviation?.personnel || "" : "",
        cargoWeightKg: app.transportType === "aviation" ? app.aviation?.cargoWeightKg || "" : "",
        transportedPersonnelOrCargoWeight: aviationTransportLoad(app),
        purpose: app.transportType === "aviation" ? app.aviation?.airJustification || "" : "",
        ...autoDetails,
        ...railDetails,
        returnCargo: app.auto?.returnCargoPlan || "",
        weightKg: app.weightKg,
        trips,
        distanceKm: calculation.distanceKm || 0,
        motorResourceKm,
        cost: calculation.preliminaryCost || 0,
        status: app.status
      };
    });
  let plan = store.monthlyPlans.find((item) => item.month === month);
  if (!plan) {
    plan = { id: `PLAN-${month}`, month, status: "Черновик", generatedAt: "", lockedAt: "", entries: [], log: [] };
    store.monthlyPlans.push(plan);
  }
  plan.entries = entries;
  plan.generatedAt = new Date().toISOString();
  plan.status = isLockDateReached(store, month) ? "Утверждён" : "Собран";
  const reverse = reverseMatches(store, month);
  plan.reverseMatchCount = reverse.length;
  if (reverse.length) {
    const message = `Обнаружены встречные рейсы: ${reverse.length}. Откройте раздел встречной логистики для объединения.`;
    const alreadyExists = store.notifications.some((item) => item.type === "reverse_detected" && item.month === month && item.message === message);
    if (!alreadyExists) {
      store.notifications.push({ at: new Date().toISOString(), type: "reverse_detected", month, message });
    }
  }
  if (plan.status === "Утверждён" && !plan.lockedAt) plan.lockedAt = new Date().toISOString();
  plan.log.push({ at: new Date().toISOString(), userId: user.id, userName: user.name, action: "Автосборка месячного плана" });
  store.applications.forEach((app) => {
    if (plan.status === "Утверждён" && entries.some((entry) => entry.applicationId === app.id)) {
      app.status = "approved_readonly";
    }
  });
  return plan;
}

function enrichMonthlyPlan(store, plan) {
  if (!plan) return plan;
  return {
    ...plan,
    entries: (plan.entries || []).map((entry) => {
      const app = store.applications.find((item) => item.id === entry.applicationId);
      if (entry.transportType === "auto") {
        const autoDetails = autoPlanDetails(app, entry);
        return Object.fromEntries(Object.entries({ ...autoDetails, ...entry }).map(([key, value]) => [key, value === undefined || value === null ? "" : value]));
      }
      if (entry.transportType === "rail") {
        const railDetails = railPlanDetails(app);
        return { ...railDetails, ...entry };
      }
      if (entry.transportType !== "aviation") return entry;
      return {
        ...entry,
        date: entry.date || app?.aviation?.flightDate || app?.plannedDate || "",
        requestFor: entry.requestFor || app?.aviation?.requestFor || "",
        aircraftType: entry.aircraftType || app?.aviation?.aircraftType || "",
        flightRoute: entry.flightRoute || (app ? `${app.aviation?.airfieldFrom || app.origin} - ${app.aviation?.airfieldTo || app.destination}` : entry.route || ""),
        personnel: entry.personnel || app?.aviation?.personnel || "",
        cargoWeightKg: entry.cargoWeightKg || app?.aviation?.cargoWeightKg || "",
        transportedPersonnelOrCargoWeight: entry.transportedPersonnelOrCargoWeight || aviationTransportLoad(app),
        purpose: entry.purpose || app?.aviation?.airJustification || ""
      };
    })
  };
}

function runScheduledPlanning(store) {
  const month = monthKey();
  const today = todayLocalIso();
  const autoDate = effectiveConfigDate(store, month, "autoPlanDay");
  const lockDate = effectiveConfigDate(store, month, "planLockDay");
  const plan = store.monthlyPlans.find((item) => item.month === month);
  const shouldGenerate = today >= autoDate && (!plan || !plan.generatedAt);
  const shouldLock = today >= lockDate && (!plan || plan.status !== "Утверждён");
  if (!shouldGenerate && !shouldLock) return false;
  generateMonthlyPlan(store, { id: "", name: "Система", role: "system" }, month);
  return true;
}

function isLockDateReached(store, month) {
  const now = new Date();
  const lockDate = effectiveConfigDate(store, month, "planLockDay");
  return monthKey(now) === month && dateOnly(now) >= lockDate;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function effectiveConfigDate(store, month, key) {
  const config = store.refs.scheduleConfig || {};
  const day = Number(config[key] || 25);
  const date = new Date(`${month}-${String(day).padStart(2, "0")}T00:00:00`);
  if (config.weekendPolicy === "next_working_day") {
    while ([0, 6].includes(date.getDay())) {
      date.setDate(date.getDate() + 1);
    }
  }
  return dateOnly(date);
}

function reverseMatches(store, month = monthKey()) {
  const apps = store.applications.filter((app) =>
    ["approved", "execution_review", "included_monthly_plan", "approved_readonly"].includes(app.status) &&
    monthKey(app.plannedDate) === month
  );
  const matches = [];
  for (let i = 0; i < apps.length; i += 1) {
    for (let j = i + 1; j < apps.length; j += 1) {
      const a = apps[i];
      const b = apps[j];
      const isMirror = a.origin === b.destination && a.destination === b.origin;
      const days = Math.abs((new Date(a.plannedDate) - new Date(b.plannedDate)) / 86400000);
      if (isMirror && days <= 3) {
        matches.push({
          id: `${a.id}_${b.id}`,
          firstId: a.id,
          secondId: b.id,
          firstRoute: `${a.origin} -> ${a.destination}`,
          secondRoute: `${b.origin} -> ${b.destination}`,
          firstDate: a.plannedDate,
          secondDate: b.plannedDate,
          dateDeltaDays: days,
          suggestion: `Объединить ${a.id} и ${b.id} в один путевой лист`
        });
      }
    }
  }
  return matches;
}

function mergeReverse(store, user, firstId, secondId) {
  const first = store.applications.find((app) => app.id === firstId);
  const second = store.applications.find((app) => app.id === secondId);
  if (!first || !second) return { error: "Заявки не найдены." };
  const match = reverseMatches(store, monthKey(first.plannedDate)).find((item) =>
    (item.firstId === firstId && item.secondId === secondId) ||
    (item.firstId === secondId && item.secondId === firstId)
  );
  if (!match) return { error: "Заявки не являются встречными по правилам MVP." };
  first.auto = first.auto || {};
  second.auto = second.auto || {};
  first.auto.returnCargoPlan = second.cargoName;
  second.auto.returnCargoPlan = first.cargoName;
  first.auto.hasReturnCargo = true;
  second.auto.hasReturnCargo = true;
  first.linkedReturnApplicationId = second.id;
  second.linkedReturnApplicationId = first.id;
  const firstFrom = first.status;
  const secondFrom = second.status;
  first.status = "merged";
  second.status = "merged";
  addLog(first, user, "Объединение встречного рейса", `Связано с ${second.id}`, firstFrom, first.status);
  addLog(second, user, "Объединение встречного рейса", `Связано с ${first.id}`, secondFrom, second.status);
  store.notifications.push({ at: new Date().toISOString(), type: "reverse_merged", message: `${first.id} и ${second.id} объединены в один путевой лист.` });
  return { first, second };
}

function csv(rows) {
  return rows.map((row) => row.map((cell) => {
    let value = String(cell ?? "");
    if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
    return `"${value.replace(/"/g, '""')}"`;
  }).join(";")).join("\n");
}

function parseCsvText(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(delimiter).map((item) => item.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(delimiter).map((item) => item.trim());
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function importRefRows(store, type, rows) {
  rows.forEach((row) => {
    if (type === "airfield") {
      store.refs.airfields.push({ code: row.code || row.код, name: row.name || row.название, city: row.city || row.город });
    } else if (type === "point") {
      store.refs.points.push({ code: row.code || row.код, name: row.name || row.название, region: row.region || row.регион });
    } else if (type === "distance") {
      const from = row.from || row["точка А"] || row.a;
      const to = row.to || row["точка Б"] || row.b;
      const transportType = row.type || row.transportType || "auto";
      store.refs.distances = store.refs.distances.filter((item) => !(item.from === from && item.to === to && item.type === transportType));
      store.refs.distances.push({ from, to, km: Number(row.km || row.км), type: transportType, source: "csv" });
    } else if (type === "tariff") {
      const transportType = row.transportType || row.type || row["тип транспорта"];
      const existing = store.refs.tariffs.find((item) => item.transportType === transportType);
      if (existing) existing.pricePerKm = Number(row.pricePerKm || row["цена за км"]);
      else store.refs.tariffs.push({ id: `t${store.refs.tariffs.length + 1}`, transportType, pricePerKm: Number(row.pricePerKm || row["цена за км"]), daysBase: 1 });
    } else if (type === "vehicle") {
      store.refs.vehicleTypes.push({ type: row.type || row["тип"], capacityKg: Number(row.capacityKg || row["грузоподъемность"]), units: Number(row.units || row["количество"]) });
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[char]));
}

function planMonthLabel(month) {
  const [year, monthNumber] = String(month || "").split("-");
  const names = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  return `${names[Number(monthNumber) - 1] || month} ${year || ""}`.trim();
}

function printablePlanDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value || "";
}

function printableCargoWeight(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "-") return normalized;
  return `${normalized} кг`;
}

function printablePlanHtml(plan, selectedType = "") {
  const validType = ["aviation", "auto", "rail"].includes(selectedType) ? selectedType : "";
  const showAll = !validType;
  const showAviation = showAll || validType === "aviation";
  const showAuto = showAll || validType === "auto";
  const showRail = showAll || validType === "rail";
  const aviationEntries = (plan?.entries || []).filter((entry) => entry.transportType === "aviation");
  const autoEntries = (plan?.entries || []).filter((entry) => entry.transportType === "auto");
  const railEntries = (plan?.entries || []).filter((entry) => entry.transportType === "rail");
  const aviationRows = aviationEntries.map((entry, index) => `<tr>
    <td>${index + 1}</td><td>${escapeHtml(printablePlanDate(entry.date))}</td><td>${escapeHtml(entry.requestFor)}</td>
    <td>${escapeHtml(entry.aircraftType)}</td><td>${escapeHtml(entry.flightRoute || entry.route)}</td>
    <td>${escapeHtml(entry.personnel)}</td><td>${escapeHtml(printableCargoWeight(entry.cargoWeightKg))}</td><td>${escapeHtml(entry.purpose)}</td>
  </tr>`).join("");
  const autoRequestRows = autoEntries.map((entry) => `<tr>
    <td>${escapeHtml(entry.autoMilitaryTransportNumber)}</td><td>${escapeHtml(entry.autoRequestCargoAndQuantity)}</td>
    <td>${escapeHtml(entry.autoDangerousCargoNumbers)}</td><td>${escapeHtml(entry.autoRequestOversizeDegree)}</td>
    <td>${escapeHtml(entry.autoRequestPersonnel)}</td><td>${escapeHtml(entry.autoRequestTransportMeans)}</td>
    <td>${escapeHtml(entry.autoLoadingPointSender)}</td><td>${escapeHtml(entry.autoUnloadingPointRecipient)}</td>
    <td>${escapeHtml(entry.autoRequestFasteningMaterial)}</td><td>${escapeHtml(entry.autoRequestChiefDetails)}</td>
    <td>${escapeHtml(entry.autoNote)}</td>
  </tr>`).join("");
  const railRows = railEntries.map((entry) => `<tr>
    <td>${escapeHtml(entry.militaryEchelonNumber)}</td><td>${escapeHtml(entry.railCargoAndQuantity)}</td><td>${escapeHtml(entry.dangerousCargoNumbers)}</td>
    <td>${escapeHtml(entry.oversizeDegree)}</td><td>${escapeHtml(entry.personnelByCategory)}</td><td>${escapeHtml(entry.railTransportMeans)}</td>
    <td>${escapeHtml(entry.loadingPointSender)}</td><td>${escapeHtml(printablePlanDate(entry.loadingDate))}</td><td>${escapeHtml(entry.unloadingPointRecipient)}</td>
    <td>${escapeHtml(entry.fasteningMaterial)}</td><td>${escapeHtml(entry.echelonChiefDetails)}</td><td>${escapeHtml(entry.railPlanNote)}</td>
  </tr>`).join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${plan?.id || "План"}</title>
  <style>@page{size:landscape;margin:10mm}body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{text-align:center;font-size:18px;line-height:1.35}h2{margin-top:28px;font-size:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:6px;font-size:12px;vertical-align:top}th{background:#eee}.plan-page{break-before:page}.auto-table{table-layout:auto}.auto-table td,.auto-table th{padding:3px;font-size:8px}.auto-request-header{font-family:"Times New Roman",serif;text-align:center;font-weight:700;margin:0 0 24px}.auto-request-title{font-size:22px;margin-bottom:6px}.auto-request-subtitle{font-size:20px}.rail-document-header{font-family:"Times New Roman",serif;margin-bottom:24px}.rail-addressee{text-align:right;font-size:18px;font-weight:700;margin:0 4% 28px 0}.rail-document-title{text-align:center;font-size:21px;font-weight:700;margin-bottom:8px}.rail-title-line{display:flex;align-items:flex-start;justify-content:center;gap:8px;font-family:"Times New Roman",serif;font-size:19px;font-weight:700;white-space:nowrap}.rail-title-blank{display:inline-flex;flex-direction:column;align-items:center}.rail-title-rule{display:block;width:210px;height:23px;border-bottom:1px solid #111}.rail-title-note{font-size:12px;font-weight:400;line-height:1.2}.rail-title-month .rail-title-rule{width:190px}.signature-block{width:78%;margin:52px auto 0}.signature-item{margin-top:34px;text-align:center}.signature-line{border-top:1px solid #111;height:8px}.signature-caption{font-family:"Times New Roman",serif;font-size:14px}button{margin-bottom:16px}@media print{button{display:none}}</style></head>
  <body><button onclick="window.print()">Печать / сохранить в PDF</button>
  ${showAviation ? `<h1>План использования военно-транспортной авиации ВВС СВО ВС РК на ${escapeHtml(planMonthLabel(plan?.month))} года</h1>
  <p>Статус: ${escapeHtml(plan?.status)}</p>
  <table><thead><tr><th rowspan="2">№ п/п</th><th rowspan="2">Дата вылета</th><th rowspan="2">Заявка (в чьих интересах)</th><th rowspan="2">Тип ВС</th><th rowspan="2">Маршрут полета</th><th colspan="2">Перевозимый</th><th rowspan="2">Цель перевозки</th></tr><tr><th>личный состав</th><th>вес груза</th></tr></thead><tbody>${aviationRows || `<tr><td colspan="8">Авиа-заявок в плане пока нет.</td></tr>`}</tbody></table>` : ""}
  ${showAuto ? `<section class="${showAll ? "plan-page" : ""}">
    <div class="auto-request-header">
      <div class="auto-request-title">Заявка</div>
      <div class="auto-request-subtitle">на погрузку воинских грузов «_____» __________ 20__ года</div>
    </div>
    <table class="auto-table"><thead><tr><th>Номера воинских эшелонов (транспортов)</th><th>Наименование и количество перевозимых воинских грузов</th><th>Номера ООН и аварийных карточек опасных грузов</th><th>Степень негабаритности</th><th>Количество личного состава по категориям</th><th>Транспортные средства</th><th>Пункт погрузки (станция, порт, аэропорт)<br>отправитель</th><th>Пункт выгрузки (станция, порт, аэропорт)<br>получатель</th><th>Обеспеченность крепёжными материалами</th><th>Воинское звание, фамилия и инициалы начальника эшелона (караула), количество л/с, оружия и боеприпасов</th><th>Примечание</th></tr><tr><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th><th>8</th><th>9</th><th>10</th><th>11</th></tr></thead><tbody>${autoRequestRows || `<tr><td colspan="11">Автомобильных заявок в плане пока нет.</td></tr>`}</tbody></table>
    <div class="signature-block">
      <div class="signature-item"><div class="signature-line"></div><div class="signature-caption">(командир воинской части, начальник учреждения)</div></div>
      <div class="signature-item"><div class="signature-line"></div><div class="signature-caption">(воинское звание, подпись, фамилия и инициалы)</div></div>
    </div>
  </section>` : ""}
  ${showRail ? `<section class="${showAll ? "plan-page" : ""}">
    <div class="rail-document-header">
      <div class="rail-addressee">Начальнику военных сообщений ВС РК</div>
      <div class="rail-document-title">Заявка</div>
      <div class="rail-title-line">
        <span>на планирование</span>
        <span class="rail-title-blank"><span class="rail-title-rule"></span><span class="rail-title-note">(характер перевозки)</span></span>
        <span>воинских перевозок в</span>
        <span class="rail-title-blank rail-title-month"><span class="rail-title-rule"></span><span class="rail-title-note">(месяц прописью)</span></span>
        <span>20__ года</span>
      </div>
    </div>
    <table class="auto-table"><thead><tr><th>Номера воинских эшелонов (транспортов)</th><th>Наименование и количество перевозимых воинских грузов</th><th>Номера ООН и аварийных карточек опасных грузов</th><th>Степень негабаритности</th><th>Количество личного состава по категориям</th><th>Транспортные средства</th><th>Пункт погрузки / отправитель</th><th>Дата погрузки</th><th>Пункт выгрузки / получатель</th><th>Обеспеченность (потребность) крепёжного материала</th><th>Воинское звание, фамилия и инициалы начальника эшелона (караула), количество л/с, оружия и боеприпасов</th><th>Примечание (тоннаж и прочее)</th></tr></thead><tbody>${railRows || `<tr><td colspan="12">ЖД-заявок в плане пока нет.</td></tr>`}</tbody></table>
    <div class="signature-block">
      <div class="signature-item"><div class="signature-line"></div><div class="signature-caption">(начальник структурного подразделения МО РК, ГШ ВС РК, вида войск)</div></div>
      <div class="signature-item"><div class="signature-line"></div><div class="signature-caption">(воинское звание, подпись, фамилия и инициалы)</div></div>
    </div>
  </section>` : ""}
  </body></html>`;
}

function formatReportDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value || "[дата]";
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function pointWithPreposition(point, direction) {
  const value = String(point || "").trim();
  const lower = value.toLowerCase();
  const rest = value.replace(/^(аэродром|станция)\s+/i, "").trim();
  if (lower.startsWith("аэродром ")) return `${direction === "from" ? "с аэродрома" : "на аэродром"} ${rest}`;
  if (lower.startsWith("станция ")) return `${direction === "from" ? "со станции" : "на станцию"} ${rest}`;
  return `${direction === "from" ? "из" : "в"} ${value}`;
}

function reportTransportPhrase(type) {
  return {
    aviation: "воздушным транспортом",
    rail: "железнодорожным транспортом",
    auto: "автомобильным транспортом"
  }[type] || `транспортом ${transportLabels[type] || type || "[тип транспорта]"}`;
}

function fallbackAiResponse(kind, app) {
  const calculation = app.calculation || {};
  if (kind === "validate") {
    const warnings = [];
    if (app.transportType === "auto" && Number(app.weightKg || 0) > 10000 && Number(app.auto?.vehicleCount || 1) <= 1) {
      warnings.push("Груз тяжелее 10 тонн не рекомендуется назначать на один автомобиль. Проверьте количество машин или смените тип перевозки.");
    }
    if (app.transportType === "aviation" && !app.aviation?.airJustification && !app.justification) {
      warnings.push("Для авиаперевозки требуется обоснование необходимости перевозки воздушным транспортом.");
    }
    if (app.origin === app.destination) warnings.push("Точка отправления и назначения совпадают.");
    if (calculation.error) warnings.push(calculation.error);
    return warnings.length ? warnings.join("\n") : "Логических предупреждений по MVP-правилам не найдено.";
  }
  if (kind === "report") {
    const route = `${pointWithPreposition(app.origin, "from")} ${pointWithPreposition(app.destination, "to")}`;
    const justification = app.justification || app.aviation?.airJustification || "уточняется";
    return `Кому: ${app.recipient || "Получатель не указан"}\nОт кого: ${app.sender || "Отправитель не указан"}\n\nРАПОРТ\n\nПрошу разрешить перевозку груза «${app.cargoName || "Наименование не указано"}» ${route} ${formatReportDate(app.plannedDate)} ${reportTransportPhrase(app.transportType)}.\nВес груза: ${app.weightKg || "не указан"} кг. Основание: ${justification}.\n\nДата. Подпись.`;
  }
  return [
    `Заявка ${app.id}: ${app.cargoName || "груз не указан"}.`,
    `Маршрут: ${app.origin} -> ${app.destination}, дата: ${app.plannedDate}.`,
    `Тип перевозки: ${transportLabels[app.transportType] || app.transportType}, срочность: ${app.urgency}, вес: ${app.weightKg} кг.`,
    `Статус: ${statuses[app.status] || app.status}.`,
    calculation.error ? `Расчёт требует внимания: ${calculation.error}` : `Предварительный расчёт: ${calculation.preliminaryCost || 0} тг, срок ${calculation.estimatedDays || 0} дн.`
  ].join("\n");
}

function buildAiPrompt(kind, app) {
  const task = {
    validate: "Проверь заявку на логические ошибки. Верни только краткие предупреждения списком. Если предупреждений нет, напиши одну фразу: Логических предупреждений не найдено.",
    report: "Сформируй официальный служебный рапорт строго по шаблону: Кому укажи получателя заявки, От кого укажи отправителя заявки, затем РАПОРТ, просьба разрешить перевозку, дата и подпись. Не используй квадратные скобки и заглушки.",
    summary: "Сделай краткую деловую выжимку заявки для руководства в 3-5 предложениях."
  }[kind] || "Сделай краткую выжимку заявки.";
  const payload = JSON.stringify({
    id: app.id,
    status: statuses[app.status] || app.status,
    transportType: transportLabels[app.transportType] || app.transportType,
    urgency: app.urgency,
    origin: app.origin,
    destination: app.destination,
    plannedDate: app.plannedDate,
    cargoName: app.cargoName,
    weightKg: app.weightKg,
    places: app.places,
    dimensions: app.dimensions,
    sender: app.sender,
    recipient: app.recipient,
    justification: app.justification || app.aviation?.airJustification || "",
    auto: app.auto || {},
    rail: app.rail || {},
    aviation: app.aviation || {},
    calculation: app.calculation || {}
  }, null, 2);

  return `<s>[INST]
Ты локальный ИИ-ассистент MVP-системы военной логистики.
Отвечай только на русском языке.
Используй только данные из JSON ниже. Не используй внешние данные.
Не повторяй эту инструкцию, не пересказывай правила, не выводи JSON, не составляй список ключевых слов.
Не придумывай варианты транспорта. В заявке выбран один тип перевозки: ${transportLabels[app.transportType] || app.transportType}.
Финальное решение всегда остаётся за человеком.

Задача:
${task}

Данные заявки в JSON:
${payload}
[/INST]`;
}

function isBadAiResponse(kind, response, app) {
  const text = String(response || "").trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  const leakedPrompt =
    lower.includes("выведите предложение") ||
    lower.includes("подчёркнут") ||
    lower.includes("подчеркнут") ||
    lower.includes("данные заявки в json") ||
    lower.includes("[/inst]") ||
    lower.includes("<s>[inst]");
  if (leakedPrompt) return true;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const repeatedLines = new Map();
  for (const line of lines) {
    if (line.length < 18) continue;
    repeatedLines.set(line, (repeatedLines.get(line) || 0) + 1);
  }
  if ([...repeatedLines.values()].some((count) => count >= 3)) return true;

  if (kind === "summary") {
    const bulletLines = lines.filter((line) => /^[-*]\s+/.test(line));
    const numberedLines = lines.filter((line) => /^\d+\.\s+/.test(line));
    if (bulletLines.length >= 4 && bulletLines.length >= Math.ceil(lines.length * 0.6)) return true;
    if (numberedLines.length >= 3) return true;
  }

  if (["summary", "report"].includes(kind)) {
    const selectedLabel = String(transportLabels[app.transportType] || app.transportType || "").toLowerCase();
    const transportMentions = Object.entries(transportLabels)
      .filter(([type]) => type !== app.transportType)
      .map(([, label]) => String(label).toLowerCase())
      .filter((label) => label && label !== selectedLabel);
    if (transportMentions.some((label) => lower.includes(label))) return true;
    if (app.transportType !== "rail" && lower.includes("железнодорож")) return true;
    if (app.transportType !== "aviation" && lower.includes("авиац")) return true;

    const requiredFacts = [app.cargoName, app.origin, app.destination, app.plannedDate]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (requiredFacts.some((fact) => !lower.includes(fact.toLowerCase()))) return true;
  }

  if (kind === "report" && !/рапорт/i.test(text)) return true;
  return false;
}

async function aiAssist(kind, app, prompt = "") {
  const fallback = () => fallbackAiResponse(kind, app);
  const selectedPrompt = prompt || buildAiPrompt(kind, app);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL || "mistral:7b-instruct-q4_0",
          stream: false,
          prompt: selectedPrompt,
          options: {
            temperature: 0.1,
            top_p: 0.8,
            repeat_penalty: 1.2
          }
        })
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const data = await response.json();
      if (data.response && !isBadAiResponse(kind, data.response, app)) return String(data.response).trim();
    }
  } catch {
    return fallback();
  }
  return fallback();
}

function routeStatic(req, res) {
  if (!["GET", "HEAD"].includes(req.method)) return send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
  const url = new URL(req.url, "http://localhost");
  let requestPath;
  try {
    requestPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  } catch {
    return send(res, 400, "Bad request");
  }
  if (requestPath.includes("\0")) return send(res, 400, "Bad request");
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    send(res, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    send(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath);
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8" };
  res.writeHead(200, { ...securityHeaders(), "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
}

async function routeApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const method = req.method;
  const store = await readStore();

  if (method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(req);
    const username = String(body.username || "").trim().slice(0, 128);
    const suppliedPassword = String(body.password || "");
    const key = loginAttemptKey(req, username);
    if (activeLoginBlock(key)) return send(res, 429, { error: "Слишком много неудачных попыток. Повторите вход через 15 минут." }, { "Retry-After": "900" });
    const user = store.users.find((item) => item.username === username);
    const passwordMatches = suppliedPassword.length <= 256 && verifyPassword(suppliedPassword, user?.passwordHash || dummyPasswordHash);
    if (!user || !passwordMatches) {
      recordLoginFailure(key);
      return send(res, 401, { error: "Неверный логин или пароль." });
    }
    loginAttempts.delete(key);
    const sid = crypto.randomBytes(32).toString("base64url");
    sessions.set(sid, { userId: user.id, createdAt: Date.now(), lastSeenAt: Date.now() });
    return send(res, 200, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(sid) });
  }

  if (method === "POST" && url.pathname === "/api/logout") {
    const sid = parseCookies(req).sid;
    if (sid) sessions.delete(sid);
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  }

  const user = requireUser(req, res, store);
  if (!user) return;

  if (method === "GET" && url.pathname === "/api/me") {
    return send(res, 200, { user: safeUser(user) });
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    return send(res, 200, { user: safeUser(user), roles, statuses, transportLabels, refs: store.refs, version: sharedDataVersion });
  }

  if (method === "GET" && url.pathname === "/api/version") {
    return send(res, 200, { version: sharedDataVersion });
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (user.role !== "admin") return send(res, 403, { error: "Доступно только администратору." });

    if (method === "GET" && url.pathname === "/api/admin/users") {
      return send(res, 200, { users: store.users.map(safeUser) });
    }

    if (method === "POST" && url.pathname === "/api/admin/users") {
      const body = await readJson(req);
      const username = String(body.username || "").trim();
      const role = String(body.role || "").trim();
      if (!username || !body.password || !body.name || !role) return send(res, 400, { error: "Заполните логин, пароль, ФИО/имя и роль." });
      const usernameError = usernamePolicyError(username);
      if (usernameError) return send(res, 400, { error: usernameError });
      if (username.length > 128 || String(body.name).length > 200 || String(body.unit || "").length > 200) return send(res, 400, { error: "Логин, имя или подразделение превышают допустимую длину." });
      if (String(body.password).length > 256) return send(res, 400, { error: "Пароль превышает допустимую длину." });
      const passwordError = passwordPolicyError(body.password);
      if (passwordError) return send(res, 400, { error: passwordError });
      if (!roles[role] || role === "admin" && store.users.some((item) => item.role === "admin" && item.username !== username)) return send(res, 400, { error: "Недопустимая роль." });
      if (store.users.some((item) => item.username === username)) return send(res, 400, { error: "Пользователь с таким логином уже существует." });
      const newUser = { id: nextUserId(store), username, passwordHash: hashPassword(body.password), role, name: String(body.name), unit: String(body.unit || "") };
      store.users.push(newUser);
      await writeStore(store);
      return send(res, 201, { user: safeUser(newUser) });
    }

    if (method === "POST" && url.pathname === "/api/admin/refs") {
      const body = await readJson(req);
      const type = String(body.type || "").trim();
      const text = (value) => String(value || "").trim();
      const number = (value) => Number(value);
      const validTransportTypes = new Set(["auto", "rail", "aviation"]);
      if (type === "airfield") {
        const code = text(body.code);
        const name = text(body.name);
        if (!code || !name) return send(res, 400, { error: "Для аэродрома заполните обязательные поля «Код» и «Название»." });
        if (store.refs.airfields.some((item) => item.code.toLowerCase() === code.toLowerCase())) return send(res, 409, { error: `Аэродром с кодом «${code}» уже существует.` });
        if (store.refs.airfields.some((item) => item.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: `Аэродром с названием «${name}» уже существует.` });
        store.refs.airfields.push({ code, name, city: text(body.city) });
      } else if (type === "point") {
        const code = text(body.code);
        const name = text(body.name);
        if (!code || !name) return send(res, 400, { error: "Для части или точки заполните обязательные поля «Код» и «Название»." });
        if (store.refs.points.some((item) => item.code.toLowerCase() === code.toLowerCase())) return send(res, 409, { error: `Точка с кодом «${code}» уже существует.` });
        if (store.refs.points.some((item) => item.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: `Точка с названием «${name}» уже существует.` });
        store.refs.points.push({ code, name, region: text(body.region) });
      } else if (type === "distance") {
        const from = text(body.from);
        const to = text(body.to);
        const km = number(body.km);
        const transportType = text(body.transportType) || "auto";
        if (!from || !to) return send(res, 400, { error: "Для маршрута заполните точки отправления и назначения." });
        if (from === to) return send(res, 400, { error: "Точки отправления и назначения должны отличаться." });
        if (!Number.isFinite(km) || km <= 0) return send(res, 400, { error: "Расстояние должно быть числом больше нуля." });
        if (!validTransportTypes.has(transportType)) return send(res, 400, { error: "Выбран неизвестный тип транспорта." });
        store.refs.distances = store.refs.distances.filter((item) => !(item.from === from && item.to === to && item.type === transportType));
        store.refs.distances.push({ from, to, km, type: transportType, source: "admin" });
      } else if (type === "tariff") {
        const transportType = text(body.transportType);
        const pricePerKm = number(body.pricePerKm);
        if (!validTransportTypes.has(transportType)) return send(res, 400, { error: "Выбран неизвестный тип транспорта." });
        if (!Number.isFinite(pricePerKm) || pricePerKm <= 0) return send(res, 400, { error: "Цена за километр должна быть числом больше нуля." });
        const existing = store.refs.tariffs.find((item) => item.transportType === transportType);
        if (existing) existing.pricePerKm = pricePerKm;
        else store.refs.tariffs.push({ id: `t${store.refs.tariffs.length + 1}`, transportType, pricePerKm, daysBase: 1 });
      } else if (type === "vehicle") {
        const vehicleType = text(body.vehicleType);
        const capacityKg = number(body.capacityKg);
        const units = number(body.units);
        if (!vehicleType) return send(res, 400, { error: "Заполните поле «Тип транспорта»." });
        if (!Number.isFinite(capacityKg) || capacityKg <= 0) return send(res, 400, { error: "Грузоподъёмность должна быть числом больше нуля." });
        if (!Number.isInteger(units) || units < 0) return send(res, 400, { error: "Количество единиц должно быть целым неотрицательным числом." });
        if (store.refs.vehicleTypes.some((item) => item.type.toLowerCase() === vehicleType.toLowerCase())) return send(res, 409, { error: `Транспорт «${vehicleType}» уже существует.` });
        store.refs.vehicleTypes.push({ type: vehicleType, capacityKg, units });
      } else {
        return send(res, 400, { error: "Неизвестный тип справочника." });
      }
      ensureCompleteDistanceMatrix(store.refs);
      await writeStore(store);
      return send(res, 200, { refs: store.refs });
    }

    if (method === "POST" && url.pathname === "/api/admin/import-csv") {
      const body = await readJson(req);
      const rows = parseCsvText(body.csv);
      if (!rows.length) return send(res, 400, { error: "CSV пустой или не распознан." });
      importRefRows(store, body.type, rows);
      ensureCompleteDistanceMatrix(store.refs);
      await writeStore(store);
      return send(res, 200, { imported: rows.length, refs: store.refs });
    }
  }

  if (method === "GET" && url.pathname === "/api/applications") {
    const apps = store.applications
      .filter((app) => canView(user, app))
      .map((app) => ({ ...app, statusLabel: statuses[app.status], transportLabel: transportLabels[app.transportType], actions: availableActions(user, app), calculation: calculate(store, app) }));
    return send(res, 200, { applications: apps });
  }

  if (method === "POST" && url.pathname === "/api/applications") {
    if (user.role !== "initiator") return send(res, 403, { error: "Создавать заявки может только инициатор." });
    const body = await readJson(req);
    const app = normalizeAppPayload(body, user, {});
    const errors = validateApplication(store, app);
    if (errors.length) return send(res, 400, { error: errors.join(" ") });
    app.id = nextApplicationId(store);
    if (!app.id) return send(res, 409, { error: "Достигнут лимит в 9999 заявок." });
    app.status = "draft";
    app.createdAt = new Date().toISOString();
    app.updatedAt = app.createdAt;
    app.createdBy = user.id;
    app.log = [];
    app.calculation = calculate(store, app);
    addLog(app, user, "Создание черновика", "", "draft", "draft");
    store.applications.push(app);
    await writeStore(store);
    return send(res, 201, { application: app });
  }

  const appMatch = url.pathname.match(/^\/api\/applications\/([^/]+)(?:\/([^/]+))?$/);
  if (appMatch) {
    const app = store.applications.find((item) => item.id === decodeURIComponent(appMatch[1]));
    if (!app || !canView(user, app)) return send(res, 404, { error: "Заявка не найдена." });
    const sub = appMatch[2];
    if (method === "GET" && !sub) return send(res, 200, { application: { ...app, actions: availableActions(user, app), calculation: calculate(store, app) } });
    if (method === "DELETE" && !sub) {
      if (!canDelete(user, app)) return send(res, 403, { error: "Удалять можно только собственный черновик или отклонённую заявку." });
      store.applications = store.applications.filter((item) => item.id !== app.id);
      await writeStore(store);
      return send(res, 200, { deleted: true, id: app.id });
    }
    if (method === "PATCH" && !sub) {
      if (!canEdit(user, app)) return send(res, 403, { error: "Редактирование недоступно." });
      const body = await readJson(req);
      const updated = normalizeAppPayload(body, user, app);
      const errors = validateApplication(store, updated);
      if (errors.length) return send(res, 400, { error: errors.join(" ") });
      Object.assign(app, updated, { updatedAt: new Date().toISOString() });
      app.calculation = calculate(store, app);
      addLog(app, user, "Редактирование заявки");
      await writeStore(store);
      return send(res, 200, { application: app });
    }
    if (method === "POST" && sub === "action") {
      const body = await readJson(req);
      const result = applyAction(store, app, user, body.action, body.comment || "");
      if (result.error) return send(res, 400, { error: result.error });
      await writeStore(store);
      return send(res, 200, { application: result.app });
    }
  }

  if (method === "GET" && url.pathname === "/api/monthly-plan") {
    if (user.role === "initiator") return send(res, 403, { error: "Месячный план недоступен инициатору." });
    const month = url.searchParams.get("month") || monthKey();
    const plan = store.monthlyPlans.find((item) => item.month === month) || { id: `PLAN-${month}`, month, status: "Не собран", entries: [] };
    return send(res, 200, { plan: { ...enrichMonthlyPlan(store, plan), reverseMatchCount: reverseMatches(store, month).length } });
  }

  if (method === "POST" && url.pathname === "/api/monthly-plan/generate") {
    if (user.role !== "execution") return send(res, 403, { error: "Месячный план формирует отдел исполнения." });
    const body = await readJson(req);
    const plan = generateMonthlyPlan(store, user, body.month || monthKey());
    await writeStore(store);
    return send(res, 200, { plan: { ...plan, reverseMatchCount: reverseMatches(store, plan.month).length } });
  }

  if (method === "GET" && url.pathname === "/api/reverse-logistics") {
    return send(res, 200, { matches: reverseMatches(store, url.searchParams.get("month") || monthKey()) });
  }

  if (method === "POST" && url.pathname === "/api/reverse-logistics/merge") {
    if (!["verifier", "execution"].includes(user.role)) return send(res, 403, { error: "Объединять рейсы может верификатор или отдел исполнения." });
    const body = await readJson(req);
    const result = mergeReverse(store, user, body.firstId, body.secondId);
    if (result.error) return send(res, 400, { error: result.error });
    await writeStore(store);
    return send(res, 200, result);
  }

  if (method === "POST" && url.pathname === "/api/ai") {
    const body = await readJson(req);
    const app = store.applications.find((item) => item.id === body.applicationId);
    if (!app || !canView(user, app)) return send(res, 404, { error: "Заявка не найдена." });
    const appForAi = { ...app, calculation: calculate(store, app) };
    const response = await aiAssist(body.kind || "summary", appForAi, body.prompt || "");
    return send(res, 200, { response });
  }

  if (method === "GET" && url.pathname === "/api/export/applications.csv") {
    const rows = [["Номер", "Статус", "Транспорт", "Дата", "Маршрут", "Груз", "Вес", "Срочность"]];
    store.applications.filter((app) => canView(user, app)).forEach((app) => rows.push([app.id, statuses[app.status], transportLabels[app.transportType], app.plannedDate, `${app.origin} -> ${app.destination}`, app.cargoName, app.weightKg, app.urgency]));
    return send(res, 200, csv(rows), { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=applications.csv" });
  }

  if (method === "GET" && url.pathname === "/api/export/monthly-plan.csv") {
    if (user.role === "initiator") return send(res, 403, { error: "Экспорт месячного плана недоступен инициатору." });
    const month = url.searchParams.get("month") || monthKey();
    const type = url.searchParams.get("type") || "";
    const selectedIds = new Set((url.searchParams.get("ids") || "").split(",").map((id) => id.trim()).filter(Boolean));
    const sourcePlan = store.monthlyPlans.find((item) => item.month === month) || { id: `PLAN-${month}`, month, status: "Не собран", entries: [] };
    const enrichedPlan = enrichMonthlyPlan(store, sourcePlan);
    const plan = selectedIds.size ? { ...enrichedPlan, entries: enrichedPlan.entries.filter((entry) => selectedIds.has(String(entry.applicationId))) } : enrichedPlan;
    let rows;
    if (type === "aviation") {
      rows = [["№ п/п", "Дата вылета", "Заявка (в чьих интересах)", "Тип ВС", "Маршрут полета", "Перевозимый личный состав", "Вес груза, кг", "Цель перевозки"]];
      plan.entries.filter((entry) => entry.transportType === "aviation").forEach((entry, index) => rows.push([index + 1, entry.date, entry.requestFor, entry.aircraftType, entry.flightRoute || entry.route, entry.personnel, entry.cargoWeightKg, entry.purpose]));
    } else if (type === "auto") {
      rows = [["№ п/п", "Заявитель перевозок, в/ч", "Наименование груза и пункт назначения", "Масса (количество) груза, т", "Воинская часть (учреждение), выделяющая автотранспорт", "Грузовых автомобилей", "Автотопливоцистерн", "Прицепов", "Начальный пункт", "Пункты назначения", "Конечный пункт", "Плечо подвоза в км и количество рейсов", "Срок перевозки: начало", "Срок перевозки: конец", "Расход моторесурсов, км", "Что планируется везти в обратном направлении", "Примечание"]];
      plan.entries.filter((entry) => entry.transportType === "auto").forEach((entry, index) => rows.push([index + 1, entry.applicant, entry.cargoAndDestination, entry.cargoMassTons, entry.allocatingUnit, entry.cargoVehicles, entry.fuelTankers, entry.trailers, entry.initialPoint, entry.destinationPoints, entry.finalPoint, entry.haulDistanceTrips, entry.transportStartDate, entry.transportEndDate, entry.motorResourceKm, entry.returnCargo, entry.autoNote]));
    } else if (type === "rail") {
      rows = [["Номера воинских эшелонов (транспортов)", "Наименование и количество перевозимых воинских грузов", "Номера ООН и аварийных карточек опасных грузов", "Степень негабаритности", "Количество личного состава по категориям", "Транспортные средства", "Пункт погрузки / отправитель", "Дата погрузки", "Пункт выгрузки / получатель", "Обеспеченность (потребность) крепёжного материала", "Воинское звание, фамилия и инициалы начальника эшелона (караула), количество л/с, оружия и боеприпасов", "Примечание (тоннаж и прочее)"]];
      plan.entries.filter((entry) => entry.transportType === "rail").forEach((entry) => rows.push([entry.militaryEchelonNumber, entry.railCargoAndQuantity, entry.dangerousCargoNumbers, entry.oversizeDegree, entry.personnelByCategory, entry.railTransportMeans, entry.loadingPointSender, entry.loadingDate, entry.unloadingPointRecipient, entry.fasteningMaterial, entry.echelonChiefDetails, entry.railPlanNote]));
    } else {
      rows = [["Заявка", "Дата", "Маршрут", "Транспорт", "Груз", "Вес", "Рейсы", "Км", "Моторесурс", "Стоимость"]];
      plan.entries.forEach((entry) => rows.push([entry.applicationId, entry.date, entry.route, transportLabels[entry.transportType], entry.cargoName, entry.weightKg, entry.trips, entry.distanceKm, entry.motorResourceKm, entry.cost]));
    }
    const filenameType = ["aviation", "auto", "rail"].includes(type) ? type : "all";
    return send(res, 200, csv(rows), { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=monthly-plan-${filenameType}.csv` });
  }

  if (method === "GET" && url.pathname === "/api/export/monthly-plan-print") {
    if (user.role === "initiator") return send(res, 403, { error: "Печатная форма месячного плана недоступна инициатору." });
    const month = url.searchParams.get("month") || monthKey();
    const type = url.searchParams.get("type") || "";
    const selectedIds = new Set((url.searchParams.get("ids") || "").split(",").map((id) => id.trim()).filter(Boolean));
    const sourcePlan = store.monthlyPlans.find((item) => item.month === month) || { id: `PLAN-${month}`, month, status: "Не собран", entries: [] };
    const enrichedPlan = enrichMonthlyPlan(store, sourcePlan);
    const plan = selectedIds.size ? { ...enrichedPlan, entries: enrichedPlan.entries.filter((entry) => selectedIds.has(String(entry.applicationId))) } : enrichedPlan;
    return sendHtml(res, printablePlanHtml(plan, type));
  }

  return send(res, 404, { error: "API route not found." });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const isStateChanging = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (isStateChanging && req.headers["x-requested-with"] !== "XMLHttpRequest") {
      return send(res, 403, { error: "Запрос отклонён защитой от подделки формы." });
    }
    const origin = req.headers.origin;
    if (isStateChanging && origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        return send(res, 403, { error: "Недопустимый источник запроса." });
      }
      if (originHost !== req.headers.host) return send(res, 403, { error: "Недопустимый источник запроса." });
    }
    const isStoreMutation = !["GET", "HEAD", "OPTIONS"].includes(req.method)
      && !["/api/login", "/api/logout", "/api/ai"].includes(pathname);
    const request = isStoreMutation
      ? enqueueMutation(() => routeApi(req, res))
      : routeApi(req, res);
    request.catch((error) => {
      console.error(error);
      if (!res.headersSent) send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : "Внутренняя ошибка сервера." });
    });
    return;
  }
  routeStatic(req, res);
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

async function runSchedulerOnce() {
  return enqueueMutation(async () => {
    const store = await readStore();
    if (runScheduledPlanning(store)) await writeStore(store);
  });
}

async function startServer() {
  validateSecurityConfig();
  await initializePostgres();
  await runSchedulerOnce();
  setInterval(() => {
    runSchedulerOnce().catch((error) => console.error("Scheduled planning failed:", error));
  }, 60 * 60 * 1000);
  setInterval(pruneSecurityState, 10 * 60 * 1000).unref();
  server.listen(PORT, HOST, () => {
    console.log(`AstanaHub logistics MVP listens on http://${HOST}:${PORT}`);
    console.log("Data backend: postgres");
  });
}

startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
