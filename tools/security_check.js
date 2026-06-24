const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const skippedDirectories = new Set([".git", "node_modules"]);
const forbiddenExtensions = new Set([".pem", ".key", ".p12", ".pfx", ".dump", ".backup"]);
const secretPatterns = [
  { label: "приватный ключ", regex: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
  { label: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: "AWS access key", regex: /\bAKIA[A-Z0-9]{16}\b/ },
  { label: "Google API key", regex: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
  { label: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { label: "старый пароль PostgreSQL", regex: /\blogistics_password\b/ },
  { label: "старый тестовый пароль", regex: /password\s*[:=]\s*["']1["']/i }
];

const failures = [];

function inspect(relativePath) {
  if (relativePath === ".env" || relativePath.startsWith(".env.")) return;
  if (relativePath === path.join("tools", "security_check.js")) return;
  const absolutePath = path.join(root, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    if (skippedDirectories.has(path.basename(relativePath))) return;
    fs.readdirSync(absolutePath).forEach((entry) => inspect(path.join(relativePath, entry)));
    return;
  }
  const extension = path.extname(relativePath).toLowerCase();
  if (forbiddenExtensions.has(extension) || extension === ".sql" && !relativePath.startsWith(`db${path.sep}migrations${path.sep}`)) {
    failures.push(`${relativePath}: потенциально секретный файл или дамп`);
    return;
  }
  if (stat.size > 5 * 1024 * 1024) return;
  const content = fs.readFileSync(absolutePath, "utf8");
  secretPatterns.forEach(({ label, regex }) => {
    if (regex.test(content)) failures.push(`${relativePath}: обнаружен признак «${label}»`);
  });
}

fs.readdirSync(root).forEach((entry) => inspect(entry));

if (failures.length) {
  console.error("Проверка безопасности не пройдена:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("Проверка безопасности пройдена: явные секреты, ключи и дампы не найдены.");
