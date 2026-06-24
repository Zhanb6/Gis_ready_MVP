const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const target = path.join(root, ".env");

if (fs.existsSync(target)) {
  console.error("Файл .env уже существует. Удалите его вручную только если действительно хотите ротировать все учётные данные.");
  process.exit(1);
}

const randomSecret = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");
const randomUsername = (prefix) => `${prefix}_${crypto.randomBytes(3).toString("hex")}`;

const values = {
  APP_PORT: "3000",
  POSTGRES_DB: "logistics_mvp",
  POSTGRES_USER: "logistics",
  POSTGRES_PASSWORD: randomSecret(32),
  COOKIE_SECURE: "false",
  BOOTSTRAP_ADMIN_USERNAME: randomUsername("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: `A1_${randomSecret()}`,
  BOOTSTRAP_INITIATOR_USERNAME: randomUsername("initiator"),
  BOOTSTRAP_INITIATOR_PASSWORD: `A1_${randomSecret()}`,
  BOOTSTRAP_OPERATOR_USERNAME: randomUsername("operator"),
  BOOTSTRAP_OPERATOR_PASSWORD: `A1_${randomSecret()}`,
  BOOTSTRAP_VERIFIER_USERNAME: randomUsername("verifier"),
  BOOTSTRAP_VERIFIER_PASSWORD: `A1_${randomSecret()}`,
  BOOTSTRAP_EXECUTION_USERNAME: randomUsername("execution"),
  BOOTSTRAP_EXECUTION_PASSWORD: `A1_${randomSecret()}`
};

const content = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
fs.writeFileSync(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log("Создан локальный .env с уникальными учётными данными. Файл исключён из Git.");
