const state = {
  user: null,
  refs: null,
  statuses: {},
  transportLabels: {},
  view: "applications",
  applications: [],
  selectedId: null,
  editingId: null,
  planMonth: null,
  version: 0,
  message: "",
  error: ""
};

let messageTimer = null;
let sharedSyncTimer = null;
let sharedSyncRunning = false;
let invalidToastTimer = null;
let pendingInvalidMessages = [];
let firstInvalidControl = null;

const actionLabels = {
  submit: "Отправить оператору",
  send_verifier: "Отправить верификатору",
  return_initiator: "Вернуть на доработку",
  return_operator: "Вернуть оператору",
  return_verifier: "Вернуть верификатору",
  approve_verifier: "Передать на утверждение",
  approve_execution: "Утвердить",
  reject: "Отклонить"
};

const appTimeZone = "Asia/Almaty";
const appDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: appTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

function $(selector) {
  return document.querySelector(selector);
}

function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function showToast(message, type = "error", duration = 7000) {
  if (!message) return;
  let stack = document.querySelector("#toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "toast-stack";
    stack.className = "toast-stack";
    stack.setAttribute("aria-live", "assertive");
    stack.setAttribute("aria-atomic", "false");
    document.body.appendChild(stack);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = type === "error" ? "!" : "✓";
  const text = document.createElement("div");
  text.className = "toast-text";
  text.textContent = String(message);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Закрыть уведомление");
  close.textContent = "×";
  close.addEventListener("click", () => toast.remove());
  toast.append(icon, text, close);
  stack.appendChild(toast);
  window.setTimeout(() => toast.remove(), duration);
}

function formatRussianDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function validationFieldLabel(control) {
  const label = control.labels?.[0] || control.closest(".field, .auth-field")?.querySelector("label");
  return String(label?.textContent || control.getAttribute("aria-label") || control.name || "Поле").replace(/\s*\*\s*$/, "").trim();
}

function localizedValidationMessage(control) {
  const label = validationFieldLabel(control);
  if (control.validity.valueMissing) return `Поле «${label}» обязательно для заполнения.`;
  if (control.validity.rangeUnderflow) {
    const minimum = control.type === "date" ? formatRussianDate(control.min) : control.min;
    return `${label}: укажите значение не меньше ${minimum}.`;
  }
  if (control.validity.rangeOverflow) return `${label}: укажите значение не больше ${control.max}.`;
  if (control.validity.typeMismatch) return `${label}: введено некорректное значение.`;
  if (control.validity.badInput) return `${label}: введите корректное число.`;
  if (control.validity.patternMismatch) return `${label}: значение не соответствует требуемому формату.`;
  if (control.validity.stepMismatch) return `${label}: выберите допустимое значение.`;
  if (control.validity.customError) return control.validationMessage;
  return `${label}: проверьте введённое значение.`;
}

document.addEventListener("invalid", (event) => {
  event.preventDefault();
  const control = event.target;
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) return;
  const message = localizedValidationMessage(control);
  if (!pendingInvalidMessages.includes(message)) pendingInvalidMessages.push(message);
  if (!firstInvalidControl) firstInvalidControl = control;
  window.clearTimeout(invalidToastTimer);
  invalidToastTimer = window.setTimeout(() => {
    showToast(pendingInvalidMessages.join("\n"));
    firstInvalidControl?.focus({ preventScroll: false });
    pendingInvalidMessages = [];
    firstInvalidControl = null;
  }, 0);
}, true);

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = {};
  appDateTimeFormatter.formatToParts(date).forEach((part) => {
    parts[part.type] = part.value;
  });
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function formatLocalDate(value) {
  return formatDateTime(value).slice(0, 10);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", ...(options.headers || {}) },
    ...options
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(data.error || data || "Ошибка запроса");
  }
  return data;
}

async function init() {
  try {
    const data = await api("/api/bootstrap");
    state.user = data.user;
    state.refs = data.refs;
    state.statuses = data.statuses;
    state.transportLabels = data.transportLabels;
    state.version = Number(data.version || 0);
    await loadApplications();
    startSharedSync();
  } catch {
    stopSharedSync();
    renderLogin();
  }
}

function startSharedSync() {
  if (sharedSyncTimer) return;
  sharedSyncTimer = setInterval(refreshSharedData, 5000);
}

function stopSharedSync() {
  if (!sharedSyncTimer) return;
  clearInterval(sharedSyncTimer);
  sharedSyncTimer = null;
}

async function refreshSharedData() {
  if (!state.user || sharedSyncRunning || document.hidden) return;
  sharedSyncRunning = true;
  try {
    const versionData = await api("/api/version");
    const version = Number(versionData.version || 0);
    if (version === state.version) return;

    const bootstrap = await api("/api/bootstrap");
    state.refs = bootstrap.refs;
    state.statuses = bootstrap.statuses;
    state.transportLabels = bootstrap.transportLabels;
    state.version = Number(bootstrap.version || version);

    if (state.view === "applications") await loadApplications();
    else if (state.view === "plan") await renderPlan();
    else if (state.view === "reverse") await renderReverse();
    else if (state.view === "refs") renderRefs();
    else if (state.view === "ai") {
      const data = await api("/api/applications");
      state.applications = data.applications;
      renderAi();
    }
  } catch (error) {
    if (String(error.message).includes("Требуется вход")) {
      state.user = null;
      stopSharedSync();
      renderLogin();
    }
  } finally {
    sharedSyncRunning = false;
  }
}

window.addEventListener("focus", refreshSharedData);

function setMessage(message, error = "", autoClearMs = 0) {
  if (messageTimer) {
    clearTimeout(messageTimer);
    messageTimer = null;
  }
  state.message = message;
  state.error = error;
  if (error) showToast(error);
  if (autoClearMs && (message || error)) {
    const currentMessage = message;
    const currentError = error;
    messageTimer = setTimeout(() => {
      if (state.message === currentMessage && state.error === currentError) {
        state.message = "";
        state.error = "";
        render();
      }
    }, autoClearMs);
  }
}

function renderLogin() {
  $("#app").innerHTML = `
    <div class="auth-screen">
      <div class="auth-layout">
        <aside class="auth-aside" aria-label="Раздел авторизации">
          <div class="auth-aside-title">Авторизация</div>
          <div class="auth-aside-note">Учетные записи создаются администратором системы</div>
        </aside>
        <main class="auth-main">
          <div class="auth-form-wrap">
            <div class="auth-system-label">Локальная логистическая система</div>
            <h1>Управление заявками</h1>
            <p class="auth-subtitle">Войдите для планирования, согласования и исполнения перевозок</p>

            <form class="auth-form" onsubmit="event.preventDefault(); submitLogin()">
              <div class="auth-field">
                <label for="login">Логин</label>
                <input id="login" name="username" autocomplete="username" placeholder="Введите логин" required autofocus>
              </div>
              <div class="auth-field">
                <label for="password">Пароль</label>
                <div class="password-field">
                  <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Введите пароль" required>
                  <button class="password-toggle" type="button" onclick="togglePassword()" aria-label="Показать пароль" title="Показать пароль">Показать</button>
                </div>
              </div>

              <p id="login-error" class="error auth-error" role="alert" style="display:none"></p>
              <button id="login-submit" class="auth-submit" type="submit">Войти</button>
            </form>
          </div>
        </main>
      </div>
    </div>
  `;
}

function togglePassword() {
  const password = $("#password");
  const toggle = $(".password-toggle");
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  toggle.textContent = show ? "Скрыть" : "Показать";
  toggle.setAttribute("aria-label", show ? "Скрыть пароль" : "Показать пароль");
  toggle.setAttribute("title", show ? "Скрыть пароль" : "Показать пароль");
}

async function submitLogin() {
  const submit = $("#login-submit");
  const errorElement = $("#login-error");
  errorElement.style.display = "none";
  submit.disabled = true;
  submit.textContent = "Вход...";
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: $("#login").value.trim(), password: $("#password").value })
    });
    state.user = data.user;
    await init();
  } catch (error) {
    showToast(error.message);
    submit.disabled = false;
    submit.textContent = "Войти";
  }
}

async function logout() {
  await api("/api/logout", { method: "POST" });
  state.user = null;
  stopSharedSync();
  renderLogin();
}

function shell(content) {
  $("#app").innerHTML = `
    <div class="shell">
      <div class="topbar">
        <div class="brand">Логистика MVP</div>
        <div class="userline">
          <span>${html(state.user.name)} - ${html(state.user.roleLabel)}</span>
          <button class="secondary" onclick="logout()">Выйти</button>
        </div>
      </div>
      <div class="layout">
        <div class="nav">
          ${navButton("applications", "Заявки")}
          ${state.user.role === "initiator" ? navButton("new", "Новая заявка") : ""}
          ${state.user.role !== "initiator" ? navButton("plan", "Месячный план") : ""}
          ${navButton("reverse", "Встречные рейсы")}
          ${navButton("ai", "ИИ-ассистент")}
          ${navButton("refs", "Справочники")}
          ${state.user.role === "admin" ? navButton("admin", "Админ-панель") : ""}
        </div>
        <main class="main">
          ${state.message ? `<div class="success">${html(state.message)}</div>` : ""}
          ${content}
        </main>
      </div>
    </div>
  `;
}

function navButton(view, label) {
  return `<button class="${state.view === view ? "active" : ""}" onclick="go('${view}')">${label}</button>`;
}

async function go(view) {
  state.editingId = null;
  state.view = view;
  setMessage("");
  if (view === "applications") await loadApplications();
  else render();
}

async function loadApplications() {
  const data = await api("/api/applications");
  state.applications = data.applications;
  render();
}

function render() {
  if (!state.user) return renderLogin();
  if (state.view === "applications") return renderApplications();
  if (state.view === "new") return renderForm();
  if (state.view === "plan") return renderPlan();
  if (state.view === "reverse") return renderReverse();
  if (state.view === "ai") return renderAi();
  if (state.view === "refs") return renderRefs();
  if (state.view === "admin") return renderAdmin();
}

function statusBadge(status) {
  const cls = status === "rejected" ? "danger" : ["approved", "included_monthly_plan", "approved_readonly", "merged"].includes(status) ? "ok" : ["returned_initiator", "returned_operator", "returned_verifier", "operator_review", "verifier_review", "execution_review"].includes(status) ? "warn" : "";
  return `<span class="badge ${cls}">${html(state.statuses[status] || status)}</span>`;
}

function renderRecommendationSummary(app) {
  const recommendation = app.calculation?.recommendation;
  const activeTypes = recommendation?.activeTypes || (recommendation?.transportType ? [recommendation.transportType] : []);
  if (!recommendation || !activeTypes.length) {
    return `
      <span class="muted">Нет рекомендации</span>
      ${app.calculation?.error ? `<div class="muted">${html(app.calculation.error)}</div>` : ""}
    `;
  }
  return `
    <span class="badge">${html(recommendation.label)}</span>
    <div class="muted">${html(recommendation.reason || "")}</div>
  `;
}

function renderApplications() {
  const rows = state.applications.map((app) => {
    const isOpen = state.selectedId === app.id;
    return `
    <tr class="application-row ${isOpen ? "application-row-open" : ""}" aria-selected="${isOpen}">
      <td><strong>${html(app.id)}</strong><br><span class="muted">${html(formatLocalDate(app.createdAt))}</span>${isOpen ? `<span class="open-document-label">Открыт</span>` : ""}</td>
      <td>${statusBadge(app.status)}</td>
      <td>${html(app.transportLabel)}${app.transportType === "aviation" ? "" : `<br><span class="muted">${html(app.urgency)}</span>`}</td>
      <td>${html(app.origin)} -> ${html(app.destination)}<br><span class="muted">${html(app.plannedDate)}</span></td>
      <td>${html(app.cargoName)}${app.transportType === "aviation" ? "" : `<br><span class="muted">${html(app.weightKg)} кг</span>`}</td>
      <td>${renderRecommendationSummary(app)}</td>
      <td class="actions">
        <button class="secondary application-open-button ${isOpen ? "is-open" : ""}" onclick="selectApp('${app.id}')" aria-expanded="${isOpen}" title="${isOpen ? "Закрыть документ" : "Открыть документ"}">${isOpen ? "Открыто" : "Открыть"}</button>
        ${state.user.role === "initiator" && ["draft", "returned_initiator", "rejected"].includes(app.status) ? `<button class="secondary" onclick="editApplication('${app.id}')">Редактировать</button>` : ""}
        ${state.user.role === "initiator" && ["draft", "rejected"].includes(app.status) ? `<button class="danger" onclick="deleteApplication('${app.id}')">Удалить</button>` : ""}
        ${(app.actions || []).map((action) => `<button onclick="doAction('${app.id}', '${action}')">${actionLabels[action]}</button>`).join("")}
      </td>
    </tr>
  `;
  }).join("");

  const selected = state.selectedId ? state.applications.find((app) => app.id === state.selectedId) : null;
  shell(`
    <div class="panel">
      <div class="toolbar">
        <h1 style="margin-right:auto">Заявки</h1>
        <a href="/api/export/applications.csv"><button>Экспорт CSV</button></a>
        <button class="secondary" onclick="loadApplications()">Обновить</button>
      </div>
      <table class="applications-table">
        <thead><tr><th>Номер</th><th>Статус</th><th>Транспорт</th><th>Маршрут</th><th>Груз</th><th>Рекомендация</th><th>Действия</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7">Заявок нет.</td></tr>`}</tbody>
      </table>
    </div>
    ${selected ? renderApplicationDetails(selected) : ""}
  `);
}

function detailRow(label, value) {
  const normalized = value === undefined || value === null || value === "" ? "Не заполнено" : value;
  return `<tr><th>${html(label)}</th><td>${html(normalized)}</td></tr>`;
}

function detailRowHtml(label, valueHtml) {
  return `<tr><th>${html(label)}</th><td>${valueHtml || `<span class="muted">Не заполнено</span>`}</td></tr>`;
}

function renderDetailSection(title, rows) {
  const visibleRows = rows.filter(Boolean).join("");
  if (!visibleRows) return "";
  return `
    <h3>${html(title)}</h3>
    <table class="detail-table">
      <tbody>${visibleRows}</tbody>
    </table>
  `;
}

function renderModalityDetails(app) {
  if (app.transportType === "aviation") {
    return renderDetailSection("Поля авиа", [
      detailRow("Аэродром отправления", app.aviation?.airfieldFrom),
      detailRow("Аэродром назначения", app.aviation?.airfieldTo),
      detailRow("Личный состав", app.aviation?.personnel),
      detailRow("Вес груза", formatOptionalWeight(app.aviation?.cargoWeightKg)),
      detailRow("Заявка (в чьих интересах)", app.aviation?.requestFor),
      detailRow("Тип ВС", app.aviation?.aircraftType),
      detailRow("Дата", app.aviation?.flightDate),
      detailRow("Вес более 100 кг и размер более 150 × 120 × 70 см", app.aviation?.oversizedCargo ? "Да" : "Нет"),
      app.aviation?.oversizedCargo ? detailRow("Вес одного места", `${app.aviation.exactWeightKg} кг`) : "",
      app.aviation?.oversizedCargo ? detailRow("Габариты груза", `${app.aviation.exactDimensions} см`) : "",
      detailRow("Чем вызвана необходимость перевозки воздушным транспортом", app.aviation?.airJustification),
      detailRow("Примечание", app.comment)
    ]);
  }
  if (app.transportType === "rail") {
    return renderDetailSection("Поля ЖД", [
      detailRow("Номер воинского эшелона (транспорта)", app.rail?.militaryEchelonNumber),
      detailRow("Станция отправления", app.rail?.stationFrom),
      detailRow("Станция назначения", app.rail?.stationTo),
      detailRow("Дата отправки", app.rail?.departureDate),
      detailRow("Номер ООН опасного груза", app.rail?.unNumber),
      detailRow("Номер аварийной карточки", app.rail?.emergencyCardNumber),
      detailRow("Степень негабаритности", app.rail?.oversizeDegree),
      detailRow("Личный состав по категориям", app.rail?.personnelByCategory),
      detailRow("Транспортные средства", app.rail?.wagonNumber),
      detailRow("Крепёжный материал", app.rail?.fasteningMaterial),
      detailRow("Начальник эшелона (караула), личный состав, оружие и боеприпасы", app.rail?.echelonChiefDetails),
      detailRow("Примечание (тоннаж и прочее)", app.rail?.railNote)
    ]);
  }
  if (app.transportType === "auto") {
    return renderDetailSection("Поля авто", [
      detailRow("Тип транспорта", "Автомобиль"),
      detailRow("Дата выезда", app.auto?.departureDate),
      detailRow("Количество машин", app.auto?.vehicleCount),
      detailRow("Количество машино-рейсов", app.auto?.trips),
      detailRow("Номер воинского транспорта", app.auto?.militaryTransportNumber),
      detailRow("Номер ООН опасного груза", app.auto?.unNumber),
      detailRow("Номер аварийной карточки", app.auto?.emergencyCardNumber),
      detailRow("Степень негабаритности", app.auto?.oversizeDegree),
      detailRow("Личный состав по категориям", app.auto?.personnelByCategory),
      detailRow("Часть, выделяющая автотранспорт", app.auto?.allocatingUnit),
      detailRow("Количество автотопливоцистерн", app.auto?.fuelTankers),
      detailRow("Количество прицепов", app.auto?.trailers),
      detailRow("Промежуточные пункты назначения", app.auto?.destinationPoints),
      detailRow("Конечная дата перевозки", app.auto?.transportEndDate),
      detailRow("Обеспеченность крепёжными материалами", app.auto?.fasteningMaterial),
      detailRow("Начальник транспорта (караула), личный состав, оружие и боеприпасы", app.auto?.chiefDetails),
      detailRow("Наличие обратного груза", app.auto?.hasReturnCargo ? "Да" : "Нет"),
      app.auto?.hasReturnCargo ? detailRow("Что планируется везти обратно", app.auto?.returnCargoPlan) : "",
      detailRow("Примечание", app.auto?.autoNote)
    ]);
  }
  return "";
}

function formatOptionalWeight(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "-") return normalized;
  return `${normalized} кг`;
}

function renderApplicationWarnings(app) {
  const warnings = getLogicalWarnings({
    transportType: app.transportType,
    urgency: app.urgency,
    origin: app.origin,
    destination: app.destination,
    weightKg: app.weightKg,
    vehicleCount: app.auto?.vehicleCount
  });
  if (app.calculation?.error) warnings.push(app.calculation.error);
  if (!warnings.length) return `<div class="success compact">Логических предупреждений не найдено.</div>`;
  return `
    <div class="notice compact">
      <strong>Логическая проверка:</strong><br>
      ${warnings.map((warning) => `- ${html(warning)}`).join("<br>")}
    </div>
  `;
}

function renderApplicationDetails(app) {
  const calc = app.calculation || {};
  const recommendation = calc.recommendation;
  const recommendationText = recommendation?.activeTypes?.length
    ? `${recommendation.label}. ${recommendation.reason || ""}`
    : "Нет рекомендации";
  const motorResource = app.transportType === "auto" && calc.distanceKm
    ? `${calc.distanceKm * Number(app.auto?.trips || 1)} км`
    : "Не применяется";
  return `
    <div class="open-document-banner" role="status">
      <span>Документ</span>
      <strong>Заявка № ${html(app.id)} — ${html(app.cargoName)}</strong>
    </div>
    <div class="split">
      <div class="panel">
        <h2>${html(app.id)} - ${html(app.cargoName)}</h2>
        ${renderApplicationWarnings(app)}
        ${renderDetailSection("Основное", app.transportType === "aviation" ? [
          detailRowHtml("Статус", statusBadge(app.status)),
          detailRow("Тип перевозки", app.transportLabel || state.transportLabels[app.transportType] || app.transportType),
          detailRow("Наименование грузов", app.cargoName),
          detailRow("Наименование Отправителя", app.sender),
          detailRow("Наименование Получателя", app.recipient)
        ] : [
          detailRowHtml("Статус", statusBadge(app.status)),
          detailRow("Тип перевозки", app.transportLabel || state.transportLabels[app.transportType] || app.transportType),
          detailRow("Срочность", app.urgency),
          detailRow("Маршрут", `${app.origin} -> ${app.destination}`),
          detailRow("Планируемая дата", app.plannedDate),
          detailRow("Отправитель", app.sender),
          detailRow("Получатель", app.recipient),
          detailRow("Обоснование", app.justification)
        ])}
        ${app.transportType === "aviation" ? "" : renderDetailSection("Груз", [
          detailRow("Наименование", app.cargoName),
          detailRow("Категория", app.cargoCategory),
          detailRow("Вес общий", `${app.weightKg || 0} кг`),
          detailRow("Вес одного места", app.placeWeightKg ? `${app.placeWeightKg} кг` : ""),
          detailRow("Объем", `${app.volumeM3 || 0} м3`),
          detailRow("Количество мест", app.places),
          detailRow("Габариты одного места", app.dimensions)
        ])}
        ${app.transportType === "aviation" ? "" : renderDetailSection("Расчёт и подсказки", [
          detailRow("Рекомендация транспорта", recommendationText),
          detailRow("Расстояние", calc.distanceKm ? `${calc.distanceKm} км` : ""),
          detailRow("Стоимость / срок", calc.error ? calc.error : `${calc.preliminaryCost} тг / ${calc.estimatedDays} дн.`),
          detailRow("Моторесурс", motorResource)
        ])}
        ${renderModalityDetails(app)}
        ${renderVerifierCorrection(app)}
      </div>
      <div class="panel">
        <h3>История действий</h3>
        <table>
          <tbody>
            ${(app.log || []).slice().reverse().map((item) => `<tr><td>${html(formatDateTime(item.at))}<br>${html(item.userName)}<br><strong>${html(item.action)}</strong><br><span class="muted">${html(item.comment || "")}</span></td></tr>`).join("") || `<tr><td>История пустая.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function routeOptionsFor(type, selected) {
  const values = type === "aviation" ? state.refs.airfields : type === "rail" ? state.refs.stations : state.refs.points;
  return optionList(values, selected, "Выберите...");
}

function renderVerifierCorrection(app) {
  if (state.user.role !== "verifier" || !["verifier_review", "returned_verifier"].includes(app.status)) return "";
  return `
    <div style="margin-top:14px">
      <h3>Корректировка верификатора</h3>
      <form id="correction-form-${html(app.id)}" class="grid" onsubmit="submitCorrection(event, '${html(app.id)}')">
        <div class="field"><label>Срочность</label><select name="urgency" required>${optionList(state.refs.urgency, app.urgency, "Выберите срочность")}</select></div>
        <div class="field"><label>Точка А</label><select name="origin" required>${routeOptionsFor(app.transportType, app.origin)}</select></div>
        <div class="field"><label>Точка Б</label><select name="destination" required>${routeOptionsFor(app.transportType, app.destination)}</select></div>
        <div class="field"><label>Планируемая дата</label><input name="plannedDate" type="date" min="${todayIso()}" value="${html(app.plannedDate)}" required></div>
        <div class="field full"><label>Комментарий корректировки</label><textarea name="comment" required>${html(app.comment || "")}</textarea></div>
        <div class="field"><label>&nbsp;</label><button>Сохранить корректировку</button></div>
      </form>
    </div>
  `;
}

async function submitCorrection(event, id) {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(event.target).entries());
    await api(`/api/applications/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
    setMessage("Корректировка сохранена.");
    await loadApplications();
    state.selectedId = id;
    renderApplications();
  } catch (error) {
    setMessage("", error.message);
    renderApplications();
  }
}

function selectApp(id) {
  state.selectedId = state.selectedId === id ? null : id;
  renderApplications();
}

function editApplication(id) {
  const app = state.applications.find((item) => item.id === id);
  if (!app) return;
  state.editingId = id;
  state.view = "new";
  state.selectedId = null;
  setMessage("");
  renderForm();
}

async function deleteApplication(id) {
  if (!confirm(`Удалить заявку ${id}? Это действие нельзя отменить.`)) return;
  try {
    await api(`/api/applications/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.selectedId === id) state.selectedId = null;
    setMessage("Заявка удалена.");
    await loadApplications();
  } catch (error) {
    setMessage("", error.message);
    renderApplications();
  }
}

async function doAction(id, action) {
  const comment = action.startsWith("return_") || action === "reject" ? prompt("Комментарий/причина:") || "" : "";
  try {
    await api(`/api/applications/${encodeURIComponent(id)}/action`, {
      method: "POST",
      body: JSON.stringify({ action, comment })
    });
    setMessage("Действие выполнено.");
    await loadApplications();
  } catch (error) {
    setMessage("", error.message);
    renderApplications();
  }
}

function renderForm() {
  let editingApp = state.editingId ? state.applications.find((app) => app.id === state.editingId) : null;
  if (state.editingId && !editingApp) state.editingId = null;
  shell(`
    <div class="panel">
      <div class="toolbar">
        <h1 style="margin-right:auto">${editingApp ? `Редактирование заявки ${html(editingApp.id)}` : "Новая заявка"}</h1>
        ${editingApp ? `<button type="button" class="secondary" onclick="go('applications')">Отмена</button>` : ""}
      </div>
      <form id="app-form" onsubmit="saveApplication(event)">
        ${formFields()}
        <div id="route-distance-notice"></div>
        <div id="live-logic-warnings"></div>
        <div id="live-recommendation" class="recommendation-panel"></div>
        <div class="toolbar">
          <button type="submit">${editingApp ? "Сохранить изменения" : "Сохранить черновик"}</button>
        </div>
      </form>
      <div id="preview"></div>
    </div>
  `);
  $("#transportType").addEventListener("change", () => {
    refreshDynamicFields();
    updateRouteDistanceNotice();
    updateLiveLogicWarnings();
    updateLiveRecommendation();
  });
  $("#app-form").addEventListener("input", () => {
    updateRouteDistanceNotice();
    updateLiveLogicWarnings();
    updateLiveRecommendation();
  });
  $("#app-form").addEventListener("change", () => {
    updateRouteDistanceNotice();
    updateLiveLogicWarnings();
    updateLiveRecommendation();
  });
  if (editingApp) $("#transportType").value = editingApp.transportType;
  refreshDynamicFields();
  if (editingApp) populateApplicationForm(editingApp);
  attachNumericGuards();
  updateRouteDistanceNotice();
  updateLiveLogicWarnings();
  updateLiveRecommendation();
}

function setFormValue(name, value) {
  const control = document.querySelector(`#app-form [name="${name}"]`);
  if (control) control.value = value ?? "";
}

function setDimensionValues(prefix, value) {
  const parts = String(value || "").replace(/[,]/g, ".").replace(/[х×*]/gi, "x").split(/\s*x\s*/i);
  ["Length", "Width", "Height"].forEach((suffix, index) => {
    setFormValue(`${prefix}${suffix}`, parts.length === 3 ? parts[index] : "");
  });
}

function populateApplicationForm(app) {
  const values = {
    urgency: app.urgency,
    plannedDate: app.plannedDate,
    origin: app.origin,
    destination: app.destination,
    cargoName: app.cargoName,
    cargoCategory: app.cargoCategory,
    weightKg: app.weightKg || "",
    placeWeightKg: app.placeWeightKg || "",
    volumeM3: app.volumeM3 || "",
    places: app.places || "",
    sender: app.sender,
    recipient: app.recipient,
    justification: app.justification,
    comment: app.comment
  };
  Object.entries(values).forEach(([name, value]) => setFormValue(name, value));
  setDimensionValues("dimension", app.dimensions);

  if (app.transportType === "aviation") {
    setFormValue("aircraftType", app.aviation?.aircraftType);
    setFormValue("requestFor", app.aviation?.requestFor);
    setFormValue("personnel", app.aviation?.personnel);
    setFormValue("aviationCargoWeightKg", app.aviation?.cargoWeightKg);
    setFormValue("airJustification", app.aviation?.airJustification);
    const oversizedValue = app.aviation?.oversizedCargo ? "1" : "0";
    const oversizedRadio = document.querySelector(`input[name="oversizedCargo"][value="${oversizedValue}"]`);
    if (oversizedRadio) oversizedRadio.checked = true;
    toggleAviationCargoFields();
    if (app.aviation?.oversizedCargo) {
      setFormValue("exactWeightKg", app.aviation?.exactWeightKg);
      setDimensionValues("exactDimension", app.aviation?.exactDimensions);
    }
  } else if (app.transportType === "rail") {
    setFormValue("wagonNumber", app.rail?.wagonNumber);
    setFormValue("militaryEchelonNumber", app.rail?.militaryEchelonNumber);
    setFormValue("unNumber", app.rail?.unNumber);
    setFormValue("emergencyCardNumber", app.rail?.emergencyCardNumber);
    setFormValue("oversizeDegree", app.rail?.oversizeDegree);
    setFormValue("personnelByCategory", app.rail?.personnelByCategory);
    setFormValue("fasteningMaterial", app.rail?.fasteningMaterial);
    setFormValue("echelonChiefDetails", app.rail?.echelonChiefDetails);
    setFormValue("railNote", app.rail?.railNote);
  } else if (app.transportType === "auto") {
    setFormValue("vehicleCount", app.auto?.vehicleCount || "");
    setFormValue("trips", app.auto?.trips || "");
    setFormValue("autoMilitaryTransportNumber", app.auto?.militaryTransportNumber);
    setFormValue("autoUnNumber", app.auto?.unNumber);
    setFormValue("autoEmergencyCardNumber", app.auto?.emergencyCardNumber);
    setFormValue("autoOversizeDegree", app.auto?.oversizeDegree);
    setFormValue("autoPersonnelByCategory", app.auto?.personnelByCategory);
    setFormValue("hasReturnCargo", app.auto?.hasReturnCargo ? "1" : "");
    setFormValue("allocatingUnit", app.auto?.allocatingUnit);
    setFormValue("fuelTankers", app.auto?.fuelTankers || "");
    setFormValue("trailers", app.auto?.trailers || "");
    setFormValue("autoDestinationPoints", app.auto?.destinationPoints);
    setFormValue("transportEndDate", app.auto?.transportEndDate);
    setFormValue("autoFasteningMaterial", app.auto?.fasteningMaterial);
    setFormValue("autoChiefDetails", app.auto?.chiefDetails);
    setFormValue("autoNote", app.auto?.autoNote);
    toggleReturnCargoField();
    setFormValue("returnCargoPlan", app.auto?.returnCargoPlan);
  }
}

function refValue(item) {
  return typeof item === "string" ? item : item.name || item.type || item.code || "";
}

function refLabel(item) {
  if (typeof item === "string") return item;
  if (item.city) return `${item.code} - ${item.name} (${item.city})`;
  if (item.region) return `${item.code} - ${item.name} (${item.region})`;
  if (item.capacityKg) return `${item.type} (${item.capacityKg} кг, ${item.units} ед.)`;
  return item.name || item.type || item.code || "";
}

function optionList(values, selected = "", placeholder = "Выберите...") {
  const first = placeholder ? `<option value="">${html(placeholder)}</option>` : "";
  return first + values.map((item) => {
    const value = refValue(item);
    return `<option value="${html(value)}" ${value === selected ? "selected" : ""}>${html(refLabel(item))}</option>`;
  }).join("");
}

function almatyDateIso(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function todayIso() {
  return almatyDateIso();
}

function addDaysIso(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function railMinimumDepartureDate() {
  const editingApp = state.editingId ? state.applications.find((app) => app.id === state.editingId) : null;
  const baseDate = editingApp?.createdAt ? almatyDateIso(new Date(editingApp.createdAt)) : todayIso();
  return addDaysIso(baseDate, 3);
}

function formFields() {
  const today = todayIso();
  return `
    <div class="grid">
      <div class="field" data-field="transport"><label>Тип перевозки *</label><select id="transportType" name="transportType" required><option value="">Выберите тип</option><option value="auto">Авто</option><option value="rail">ЖД</option><option value="aviation">Авиа</option></select></div>
      <div class="field" data-aviation-hidden><label>Срочность *</label><select name="urgency" required>${optionList(state.refs.urgency, "", "Выберите срочность")}</select></div>
      <div class="field" data-field="date"><label id="planned-date-label" for="planned-date">Планируемая дата *</label><input id="planned-date" name="plannedDate" type="date" min="${today}" required></div>
      <div class="field" data-field="aircraft" data-aviation-only hidden><label>Тип ВС</label><input name="aircraftType" type="text" disabled></div>
      <div class="field" data-field="request-for" data-aviation-only hidden><label>Заявка (в чьих интересах)</label><input name="requestFor" type="text" disabled></div>
      <div class="field" data-field="origin"><label id="origin-label" for="origin">Точка А / отправления *</label><select name="origin" id="origin" required>${optionList([], "", "Сначала выберите тип перевозки")}</select></div>
      <div class="field" data-field="destination"><label id="destination-label" for="destination">Точка Б / назначения *</label><select name="destination" id="destination" required>${optionList([], "", "Сначала выберите тип перевозки")}</select></div>
      <div class="field" data-field="personnel" data-aviation-only hidden><label>Личный состав</label><input name="personnel" type="text" disabled></div>
      <div class="field" data-field="aviation-cargo-weight" data-aviation-only hidden><label>Вес груза, кг</label><input name="aviationCargoWeightKg" type="text" inputmode="decimal" placeholder="###" disabled></div>
      <div class="field" data-field="cargo"><label id="cargo-name-label">Наименование груза *</label><input name="cargoName" required></div>
      <div class="field" data-aviation-hidden><label>Категория груза</label><input name="cargoCategory"></div>
      <div class="field" data-aviation-hidden><label>Вес общий, кг *</label><input name="weightKg" type="number" min="1" required></div>
      <div class="field" data-aviation-hidden><label>Вес одного места, кг</label><input name="placeWeightKg" type="number" min="0"></div>
      <div class="field" data-aviation-hidden><label>Объем, м3</label><input name="volumeM3" type="number" min="0" step="0.1"></div>
      <div class="field" data-aviation-hidden><label>Количество мест *</label><input name="places" type="number" min="1" required></div>
      <div class="field dimension-field" data-aviation-hidden>
        <label>Габариты одного места</label>
        <div class="dimension-row">
          <input name="dimensionLength" type="text" data-dimension-part="1" inputmode="decimal" placeholder="Д" aria-label="Длина одного места">
          <span>x</span>
          <input name="dimensionWidth" type="text" data-dimension-part="1" inputmode="decimal" placeholder="Ш" aria-label="Ширина одного места">
          <span>x</span>
          <input name="dimensionHeight" type="text" data-dimension-part="1" inputmode="decimal" placeholder="В" aria-label="Высота одного места">
        </div>
      </div>
      <div class="field" data-field="sender"><label id="sender-label">Отправитель *</label><select name="sender" required>${optionList(state.refs.points, state.user.unit || "", "Выберите отправителя")}</select></div>
      <div class="field" data-field="recipient"><label id="recipient-label">Получатель *</label><select name="recipient" required>${optionList(state.refs.points, "", "Выберите получателя")}</select></div>
      <div class="field full" data-aviation-hidden><label>Обоснование</label><textarea name="justification"></textarea></div>
    </div>
    <div id="dynamic-fields" class="grid" style="margin-top:12px"></div>
  `;
}

function refreshDynamicFields() {
  const type = $("#transportType").value;
  const container = $("#dynamic-fields");
  const originLabel = $("#origin-label");
  const destinationLabel = $("#destination-label");
  const plannedDateLabel = $("#planned-date-label");
  const cargoNameLabel = $("#cargo-name-label");
  const senderLabel = $("#sender-label");
  const recipientLabel = $("#recipient-label");
  const plannedDateInput = $("#planned-date");
  plannedDateInput.min = type === "rail" ? railMinimumDepartureDate() : todayIso();
  plannedDateInput.title = type === "rail" ? `Дата отправки доступна с ${railMinimumDepartureDate()}` : "";
  const aviationSelected = type === "aviation";
  document.querySelectorAll("[data-aviation-hidden]").forEach((field) => {
    field.hidden = aviationSelected;
    field.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = aviationSelected;
    });
  });
  document.querySelectorAll("[data-aviation-only]").forEach((field) => {
    field.hidden = !aviationSelected;
    field.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = !aviationSelected;
    });
  });
  document.querySelectorAll("[data-field]").forEach((field) => {
    field.style.order = "";
  });
  if (aviationSelected) {
    const aviationOrder = ["transport", "origin", "destination", "personnel", "aviation-cargo-weight", "request-for", "aircraft", "date", "cargo", "sender", "recipient"];
    aviationOrder.forEach((name, index) => {
      const field = document.querySelector(`[data-field="${name}"]`);
      if (field) field.style.order = String(index);
    });
  }
  if (type === "aviation") {
    originLabel.textContent = "Аэродром отправления *";
    destinationLabel.textContent = "Аэродром назначения *";
    plannedDateLabel.textContent = "Дата *";
    cargoNameLabel.textContent = "Наименование грузов *";
    senderLabel.textContent = "Наименование Отправителя *";
    recipientLabel.textContent = "Наименование Получателя *";
    $("#origin").innerHTML = optionList(state.refs.airfields, "", "Выберите аэродром отправления");
    $("#destination").innerHTML = optionList(state.refs.airfields, "", "Выберите аэродром назначения");
    container.innerHTML = `
      <div class="field full">
        <label>Вес более 100 кг и размер более 150 × 120 × 70 см?</label>
        <div class="radio-group">
          <label class="radio-option"><input type="radio" name="oversizedCargo" value="0" checked onchange="toggleAviationCargoFields()"> Нет</label>
          <label class="radio-option"><input type="radio" name="oversizedCargo" value="1" onchange="toggleAviationCargoFields()"> Да</label>
        </div>
      </div>
      <div class="field" data-aviation-cargo-detail hidden>
        <label>Вес одного места, кг *</label>
        <input name="exactWeightKg" type="number" min="100.01" step="0.01" disabled>
      </div>
      <div class="field dimension-field aviation-dimension-field" data-aviation-cargo-detail hidden>
        <label>Габариты груза, см *</label>
        <div class="dimension-row aviation-dimension-row">
          <input name="exactDimensionLength" type="text" data-dimension-part="1" inputmode="decimal" placeholder="Длина" aria-label="Длина груза" disabled>
          <span>x</span>
          <input name="exactDimensionWidth" type="text" data-dimension-part="1" inputmode="decimal" placeholder="Ширина" aria-label="Ширина груза" disabled>
          <span>x</span>
          <input name="exactDimensionHeight" type="text" data-dimension-part="1" inputmode="decimal" placeholder="Высота" aria-label="Высота груза" disabled>
        </div>
      </div>
      <div class="field full"><label>Чем вызвана необходимость перевозки воздушным транспортом *</label><textarea name="airJustification" required></textarea></div>
      <div class="field full"><label>Примечание</label><textarea name="comment"></textarea></div>
    `;
  } else if (type === "rail") {
    cargoNameLabel.textContent = "Наименование груза *";
    senderLabel.textContent = "Отправитель *";
    recipientLabel.textContent = "Получатель *";
    originLabel.textContent = "Станция отправления *";
    destinationLabel.textContent = "Станция назначения *";
    plannedDateLabel.textContent = "Дата отправки *";
    $("#origin").innerHTML = optionList(state.refs.stations, "", "Выберите станцию отправления");
    $("#destination").innerHTML = optionList(state.refs.stations, "", "Выберите станцию назначения");
    container.innerHTML = `
      <div class="field"><label>Номер воинского эшелона (транспорта)</label><input name="militaryEchelonNumber"></div>
      <div class="field"><label>Номер ООН опасного груза</label><input name="unNumber"></div>
      <div class="field"><label>Номер аварийной карточки</label><input name="emergencyCardNumber"></div>
      <div class="field"><label>Степень негабаритности</label><input name="oversizeDegree"></div>
      <div class="field"><label>Количество личного состава по категориям</label><input name="personnelByCategory" placeholder="например: офицеры — 2, военнослужащие — 15"></div>
      <div class="field"><label>Транспортные средства *</label><input name="wagonNumber" placeholder="количество и род подвижного состава" required></div>
      <div class="field full"><label>Обеспеченность / потребность в крепёжном материале</label><textarea name="fasteningMaterial"></textarea></div>
      <div class="field full"><label>Воинское звание, фамилия и инициалы начальника эшелона (караула), количество л/с, оружия и боеприпасов</label><textarea name="echelonChiefDetails"></textarea></div>
      <div class="field full"><label>Примечание (тоннаж и прочее)</label><textarea name="railNote"></textarea></div>
    `;
  } else if (type === "auto") {
    cargoNameLabel.textContent = "Наименование груза *";
    senderLabel.textContent = "Отправитель *";
    recipientLabel.textContent = "Получатель *";
    originLabel.textContent = "Точка отправления *";
    destinationLabel.textContent = "Точка назначения *";
    plannedDateLabel.textContent = "Дата выезда *";
    $("#origin").innerHTML = optionList(state.refs.points, "", "Выберите точку А");
    $("#destination").innerHTML = optionList(state.refs.points, "", "Выберите точку Б");
    container.innerHTML = `
      <div class="field"><label>Тип транспорта</label><input name="truckType" value="Автомобиль" readonly></div>
      <div class="field"><label>Количество машин *</label><input name="vehicleCount" type="number" min="1" required></div>
      <div class="field"><label>Количество машино-рейсов *</label><input name="trips" type="number" min="1" required></div>
      <div class="field"><label>Номер воинского транспорта</label><input name="autoMilitaryTransportNumber"></div>
      <div class="field"><label>Номер ООН опасного груза</label><input name="autoUnNumber"></div>
      <div class="field"><label>Номер аварийной карточки</label><input name="autoEmergencyCardNumber"></div>
      <div class="field"><label>Степень негабаритности</label><input name="autoOversizeDegree"></div>
      <div class="field"><label>Количество личного состава по категориям</label><input name="autoPersonnelByCategory"></div>
      <div class="field"><label>Воинская часть, выделяющая автотранспорт</label><input name="allocatingUnit"></div>
      <div class="field"><label>Количество автотопливоцистерн</label><input name="fuelTankers" type="number" min="0"></div>
      <div class="field"><label>Количество прицепов</label><input name="trailers" type="number" min="0"></div>
      <div class="field full"><label>Промежуточные пункты назначения</label><textarea name="autoDestinationPoints"></textarea></div>
      <div class="field"><label>Конечная дата перевозки</label><input name="transportEndDate" type="date" min="${todayIso()}"></div>
      <div class="field full"><label>Обеспеченность крепёжными материалами</label><textarea name="autoFasteningMaterial"></textarea></div>
      <div class="field full"><label>Воинское звание, фамилия и инициалы начальника транспорта (караула), количество л/с, оружия и боеприпасов</label><textarea name="autoChiefDetails"></textarea></div>
      <div class="field"><label>Наличие обратного груза</label><select name="hasReturnCargo" onchange="toggleReturnCargoField()"><option value="">Нет</option><option value="1">Да</option></select></div>
      <div class="field full" id="return-cargo-field" hidden><label>Что планируется везти обратно</label><textarea name="returnCargoPlan"></textarea></div>
      <div class="field full"><label>Примечание</label><textarea name="autoNote"></textarea></div>
    `;
  } else {
    cargoNameLabel.textContent = "Наименование груза *";
    senderLabel.textContent = "Отправитель *";
    recipientLabel.textContent = "Получатель *";
    originLabel.textContent = "Точка А / отправления *";
    destinationLabel.textContent = "Точка Б / назначения *";
    plannedDateLabel.textContent = "Планируемая дата *";
    $("#origin").innerHTML = optionList([], "", "Сначала выберите тип перевозки");
    $("#destination").innerHTML = optionList([], "", "Сначала выберите тип перевозки");
    container.innerHTML = "";
  }
  toggleReturnCargoField();
  toggleAviationCargoFields();
  attachNumericGuards();
}

function toggleAviationCargoFields() {
  const selected = document.querySelector('input[name="oversizedCargo"]:checked');
  const showDetails = selected?.value === "1";
  document.querySelectorAll("[data-aviation-cargo-detail]").forEach((field) => {
    field.hidden = !showDetails;
    field.querySelectorAll("input").forEach((input) => {
      input.disabled = !showDetails;
      input.required = showDetails;
      if (!showDetails) input.value = "";
    });
  });
}

function toggleReturnCargoField() {
  const field = $("#return-cargo-field");
  const select = document.querySelector('select[name="hasReturnCargo"]');
  if (!field || !select) return;
  const textarea = field.querySelector('textarea[name="returnCargoPlan"]');
  const hasReturnCargo = select.value === "1";
  field.hidden = !hasReturnCargo;
  if (textarea) {
    textarea.disabled = !hasReturnCargo;
    if (!hasReturnCargo) textarea.value = "";
  }
}

function parseDimensionParts(value) {
  const parts = String(value || "")
    .replace(/[,]/g, ".")
    .replace(/[х×*]/gi, "x")
    .split(/\s*x\s*/i)
    .map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.some((part) => part <= 0)) return null;
  return parts;
}

function collectForm() {
  const form = new FormData($("#app-form"));
  const data = Object.fromEntries([...form.entries()].map(([key, value]) => [key, value]));
  data.dimensions = composeDimensions(data.dimensionLength, data.dimensionWidth, data.dimensionHeight);
  data.exactDimensions = composeDimensions(data.exactDimensionLength, data.exactDimensionWidth, data.exactDimensionHeight);
  return data;
}

function composeDimensions(length, width, height) {
  const parts = [length, width, height].map(normalizeDimensionForSubmit);
  return parts.some(Boolean) ? parts.join(" x ") : "";
}

function normalizeDimensionForSubmit(value) {
  return String(value || "").trim().replace(",", ".");
}

function attachNumericGuards() {
  document.querySelectorAll('input[type="number"]').forEach((input) => {
    if (input.dataset.numericGuardReady) return;
    input.dataset.numericGuardReady = "1";
    input.addEventListener("input", () => {
      input.value = sanitizeNumberValue(input.value, input.step);
    });
  });
  document.querySelectorAll('input[data-dimension-part="1"]').forEach((input) => {
    if (input.dataset.dimensionGuardReady) return;
    input.dataset.dimensionGuardReady = "1";
    input.addEventListener("input", (event) => {
      input.value = sanitizeDimensionPartValue(input.value, event.inputType || "");
    });
  });
}

function sanitizeNumberValue(value, step = "") {
  let normalized = String(value || "")
    .replace(",", ".")
    .replace(/[^\d.]/g, "");
  const dotIndex = normalized.indexOf(".");
  if (dotIndex !== -1) {
    normalized = normalized.slice(0, dotIndex + 1) + normalized.slice(dotIndex + 1).replace(/[.]/g, "");
  }
  if (normalized.startsWith(".")) normalized = `0${normalized}`;
  if (!String(step).includes(".") && !normalized.includes(".")) {
    normalized = normalized.replace(/^0+(?=\d)/, "");
  }
  return normalized;
}

function sanitizeDimensionPartValue(value, inputType = "") {
  let normalized = String(value || "")
    .replace(/[.]/g, ",")
    .replace(/[^\d,]/g, "");
  const commaIndex = normalized.indexOf(",");
  if (commaIndex !== -1) {
    normalized = normalized.slice(0, commaIndex + 1) + normalized.slice(commaIndex + 1).replace(/[,]/g, "");
  }
  if (normalized.startsWith(",")) normalized = `0${normalized}`;
  if (normalized === "0") {
    return inputType.startsWith("delete") ? normalized : "0,";
  }
  if (/^0\d/.test(normalized)) {
    normalized = `0,${normalized.slice(1)}`;
  }
  return normalized;
}

function routeDistanceFor(data) {
  return (state.refs.distances || []).find((item) =>
    item.from === data.origin &&
    item.to === data.destination &&
    item.type === data.transportType
  );
}

function updateRouteDistanceNotice() {
  const target = $("#route-distance-notice");
  if (!target || !$("#app-form")) return;
  const data = collectForm();
  if (!data.transportType || !data.origin || !data.destination || data.origin === data.destination) {
    target.innerHTML = "";
    return;
  }
  const route = `${data.origin} -> ${data.destination}`;
  const transport = state.transportLabels[data.transportType] || "транспорт";
  const distance = routeDistanceFor(data);
  if (distance) {
    target.innerHTML = `<div class="success compact">Расстояние найдено: ${html(route)}, ${html(transport)}, ${html(distance.km)} км.</div>`;
    return;
  }
  target.innerHTML = `
    <div class="notice compact">
      Для маршрута ${html(route)} (${html(transport)}) нет расстояния в матрице.
      Черновик сохранится, но отправка дальше будет заблокирована до добавления расстояния в справочник.
    </div>
  `;
}

function validateFormPayload(data) {
  const errors = [];
  const today = todayIso();
  const required = [
    ["transportType", "Тип перевозки"],
    ["plannedDate", "Планируемая дата"],
    ["origin", "Точка А / отправления"],
    ["destination", "Точка Б / назначения"],
    ["cargoName", "Наименование груза"],
    ["sender", "Отправитель"],
    ["recipient", "Получатель"]
  ];
  if (data.transportType !== "aviation") {
    required.push(["urgency", "Срочность"], ["weightKg", "Вес"], ["places", "Количество мест"]);
  }
  required.forEach(([key, label]) => {
    if (!data[key]) errors.push(`${label}: обязательное поле.`);
  });
  if (data.origin && data.destination && data.origin === data.destination) errors.push("Точка А и Точка Б не могут совпадать.");
  if (data.plannedDate && data.plannedDate < today) errors.push("Планируемая дата не может быть в прошлом.");
  if (data.transportType !== "aviation" && Number(data.weightKg || 0) <= 0) errors.push("Вес должен быть больше 0.");
  if (data.transportType !== "aviation" && Number(data.places || 0) <= 0) errors.push("Количество мест должно быть больше 0.");
  if (data.dimensions && !parseDimensionParts(data.dimensions)) errors.push("Габариты должны быть в формате Д x Ш x В.");
  const transportRuleError = getMandatoryTransportError(data);
  if (transportRuleError) errors.push(transportRuleError);

  if (data.transportType === "aviation") {
    [["airJustification", "Причина необходимости перевозки воздушным транспортом"]].forEach(([key, label]) => {
      if (!data[key]) errors.push(`${label}: обязательное поле.`);
    });
    const cargoWeight = String(data.aviationCargoWeightKg || "").trim();
    const normalizedCargoWeight = Number(cargoWeight.replace(",", "."));
    if (cargoWeight && cargoWeight !== "-" && (!Number.isFinite(normalizedCargoWeight) || normalizedCargoWeight <= 0)) {
      errors.push("В поле веса груза укажите положительное число или символ -.");
    }
    if (data.oversizedCargo === "1") {
      const exactDimensions = parseDimensionParts(data.exactDimensions);
      if (Number(data.exactWeightKg || 0) <= 100) errors.push("Вес груза должен быть больше 100 кг.");
      if (!exactDimensions) {
        errors.push("Укажите габариты груза: длину, ширину и высоту.");
      } else if (exactDimensions[0] <= 150 && exactDimensions[1] <= 120 && exactDimensions[2] <= 70) {
        errors.push("Хотя бы один габарит груза должен превышать 150 × 120 × 70 см.");
      }
    }
  }

  if (data.transportType === "rail") {
    [["wagonNumber", "Транспортные средства"]].forEach(([key, label]) => {
      if (!data[key]) errors.push(`${label}: обязательное поле.`);
    });
    const minimumDate = railMinimumDepartureDate();
    if (data.plannedDate && data.plannedDate < minimumDate) {
      errors.push(`Дата отправки для ЖД должна быть не раньше ${minimumDate} — через 3 дня после подачи заявки.`);
    }
  }

  if (data.transportType === "auto") {
    [["vehicleCount", "Количество машин"], ["trips", "Количество машино-рейсов"]].forEach(([key, label]) => {
      if (!data[key]) errors.push(`${label}: обязательное поле.`);
    });
    if (Number(data.vehicleCount || 0) <= 0) errors.push("Количество машин должно быть больше 0.");
    if (Number(data.trips || 0) <= 0) errors.push("Количество машино-рейсов должно быть больше 0.");
    if (data.transportEndDate && data.plannedDate && data.transportEndDate < data.plannedDate) errors.push("Конечная дата перевозки не может быть раньше даты выезда.");
  }
  return errors;
}

function getTransportRecommendation(data) {
  const weight = Number(data.weightKg || 0);
  if (data.urgency === "Критическая" && weight > 0 && weight <= 10000) {
    return { transportType: "aviation", activeTypes: ["aviation"], label: "Авиа", reason: "Для критической срочности и веса до 10 тонн обязательно выбрать авиа." };
  }
  if (data.urgency === "Несрочная" && weight > 10000) {
    return { transportType: "rail", activeTypes: ["rail"], label: "ЖД", reason: "Рекомендуется ЖД для объемного груза." };
  }
  if (data.urgency === "Средняя" && weight > 0 && weight <= 10000) {
    return { transportType: "auto", activeTypes: ["auto"], label: "Авто", reason: "Обязательно выбрать автомобильный транспорт." };
  }
  if (data.urgency === "Высокая" && weight > 0 && weight <= 10000) {
    return { transportType: "", activeTypes: ["aviation", "auto"], label: "Авиа / Авто", reason: "Допустим авиационный или автомобильный транспорт." };
  }
  if (!data.urgency || !weight) {
    return { transportType: "", activeTypes: [], label: "Не определено", reason: "Введите срочность и вес, чтобы система подсветила подходящий транспорт." };
  }
  return { transportType: "", activeTypes: [], label: "Не определено", reason: "По правилам MVP рекомендация для этих параметров не определена." };
}

function getMandatoryTransportError(data) {
  const recommendation = getTransportRecommendation(data);
  const activeTypes = recommendation.activeTypes || (recommendation.transportType ? [recommendation.transportType] : []);
  if (!data.transportType || !activeTypes.length || activeTypes.includes(data.transportType)) return "";
  return `Для выбранной срочности и веса обязателен тип перевозки: ${recommendation.label}.`;
}

function getLogicalWarnings(data) {
  const warnings = [];
  const weight = Number(data.weightKg || 0);
  const vehicleCount = Number(data.vehicleCount || 0);
  if (data.transportType === "auto" && weight > 10000 && vehicleCount <= 1) {
    warnings.push("Груз тяжелее 10 тонн не рекомендуется назначать на один автомобиль. Увеличьте количество машин или выберите другой тип перевозки.");
  }
  if (data.origin && data.destination && data.origin === data.destination) {
    warnings.push("Точка отправления и назначения совпадают.");
  }
  return warnings;
}

function updateLiveLogicWarnings() {
  const target = $("#live-logic-warnings");
  if (!target || !$("#app-form")) return;
  const warnings = getLogicalWarnings(collectForm());
  if (!warnings.length) {
    target.innerHTML = "";
    return;
  }
  target.innerHTML = `
    <div class="notice compact">
      <strong>Логическая проверка:</strong><br>
      ${warnings.map((warning) => `- ${html(warning)}`).join("<br>")}
    </div>
  `;
}

function recommendationCard(type, label, description, activeTypes) {
  const active = (activeTypes || []).includes(type);
  return `
    <div class="recommendation-card ${active ? "active" : ""}">
      <div class="recommendation-title">${html(label)}</div>
      <div class="muted">${html(description)}</div>
    </div>
  `;
}

function updateLiveRecommendation() {
  const target = $("#live-recommendation");
  if (!target || !$("#app-form")) return;
  const data = collectForm();
  const recommendation = getTransportRecommendation(data);
  const activeTypes = recommendation.activeTypes || (recommendation.transportType ? [recommendation.transportType] : []);
  const hasActiveRecommendation = activeTypes.length > 0;
  const recommendationMatched = hasActiveRecommendation && activeTypes.includes(data.transportType);
  target.innerHTML = `
    <h3>Обязательный выбор транспорта</h3>
    <div class="recommendation-grid">
      ${recommendationCard("aviation", "Авиа", "Критическая срочность до 10 тонн; высокая срочность до 10 тонн как вариант.", activeTypes)}
      ${recommendationCard("rail", "ЖД", "Несрочный груз тяжелее 10 тонн.", activeTypes)}
      ${recommendationCard("auto", "Авто", "Автомобиль: средняя срочность до 10 тонн; высокая срочность до 10 тонн как вариант.", activeTypes)}
    </div>
    ${hasActiveRecommendation ? `
      <div class="${recommendationMatched ? "success" : "notice"} compact">
        <strong>${recommendationMatched ? "Выбор соответствует правилу" : "Выбор обязателен"}:</strong> ${html(recommendation.label)}. ${html(recommendation.reason)}
      </div>
    ` : ""}
  `;
}

async function saveApplication(event) {
  event.preventDefault();
  try {
    const payload = collectForm();
    const validationErrors = validateFormPayload(payload);
    if (validationErrors.length) {
      showToast(validationErrors.join("\n"));
      return;
    }
    const editingId = state.editingId;
    await api(editingId ? `/api/applications/${encodeURIComponent(editingId)}` : "/api/applications", {
      method: editingId ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    state.editingId = null;
    state.view = "applications";
    setMessage(editingId ? "Изменения сохранены." : "Черновик заявки создан.");
    await loadApplications();
  } catch (error) {
    setMessage("");
    showToast(error.message);
  }
}

async function renderPlan() {
  shell(`<div class="panel"><h1>Месячный план</h1><p>Загрузка...</p></div>`);
  const currentMonth = todayIso().slice(0, 7);
  let month = state.planMonth || currentMonth;
  const offset = monthIndex(month) - monthIndex(currentMonth);
  if (offset < -2 || offset > 2) month = currentMonth;
  state.planMonth = month;
  const canShowPrevious = monthIndex(month) > monthIndex(currentMonth) - 2;
  const canShowNext = monthIndex(month) < monthIndex(currentMonth) + 2;
  const data = await api(`/api/monthly-plan?month=${month}`);
  const plan = data.plan;
  const aviationEntries = (plan.entries || []).filter((entry) => entry.transportType === "aviation");
  const autoEntries = (plan.entries || []).filter((entry) => entry.transportType === "auto");
  const railEntries = (plan.entries || []).filter((entry) => entry.transportType === "rail");
  const aviationRows = aviationEntries.map((entry, index) => `
    <tr>
      <td class="plan-select-cell"><input class="plan-row-checkbox" data-plan-type="aviation" type="checkbox" value="${html(entry.applicationId)}" aria-label="Выбрать заявку ${html(entry.applicationId)}"></td>
      <td>${index + 1}</td>
      <td>${html(formatPlanDate(entry.date))}</td>
      <td>${html(entry.requestFor)}</td>
      <td>${html(entry.aircraftType)}</td>
      <td>${html(entry.flightRoute || entry.route)}</td>
      <td>${html(entry.personnel || "")}</td>
      <td>${html(formatOptionalWeight(entry.cargoWeightKg))}</td>
      <td>${html(entry.purpose)}</td>
    </tr>
  `).join("");
  const autoRows = autoEntries.map((entry, index) => `
    <tr>
      <td class="plan-select-cell"><input class="plan-row-checkbox" data-plan-type="auto" type="checkbox" value="${html(entry.applicationId)}" aria-label="Выбрать заявку ${html(entry.applicationId)}"></td>
      <td>${index + 1}</td>
      <td>${html(entry.applicant)}</td>
      <td>${html(entry.cargoAndDestination)}</td>
      <td>${html(entry.cargoMassTons)}</td>
      <td>${html(entry.allocatingUnit)}</td>
      <td>${html(entry.cargoVehicles)}</td>
      <td>${html(entry.fuelTankers)}</td>
      <td>${html(entry.trailers)}</td>
      <td>${html(entry.initialPoint)}</td>
      <td>${html(entry.destinationPoints)}</td>
      <td>${html(entry.finalPoint)}</td>
      <td>${html(entry.haulDistanceTrips)}</td>
      <td>${html(formatPlanDate(entry.transportStartDate))}</td>
      <td>${html(formatPlanDate(entry.transportEndDate))}</td>
      <td>${html(entry.motorResourceKm)}</td>
      <td>${html(entry.returnCargo)}</td>
      <td>${html(entry.autoNote)}</td>
    </tr>
  `).join("");
  const railRows = railEntries.map((entry) => `
    <tr>
      <td class="plan-select-cell"><input class="plan-row-checkbox" data-plan-type="rail" type="checkbox" value="${html(entry.applicationId)}" aria-label="Выбрать заявку ${html(entry.applicationId)}"></td>
      <td>${html(entry.militaryEchelonNumber)}</td>
      <td>${html(entry.railCargoAndQuantity)}</td>
      <td>${html(entry.dangerousCargoNumbers)}</td>
      <td>${html(entry.oversizeDegree)}</td>
      <td>${html(entry.personnelByCategory)}</td>
      <td>${html(entry.railTransportMeans)}</td>
      <td>${html(entry.loadingPointSender)}</td>
      <td>${html(formatPlanDate(entry.loadingDate))}</td>
      <td>${html(entry.unloadingPointRecipient)}</td>
      <td>${html(entry.fasteningMaterial)}</td>
      <td>${html(entry.echelonChiefDetails)}</td>
      <td>${html(entry.railPlanNote)}</td>
    </tr>
  `).join("");
  shell(`
    <div class="panel">
      <div class="toolbar">
        <div class="month-plan-heading">
          <h1>Месячный план</h1>
          <div class="month-navigation">
            <button class="secondary" type="button" onclick="changePlanMonth(-1)" ${canShowPrevious ? "" : "disabled"}>← Предыдущий месяц</button>
            <strong class="month-navigation-label">${html(formatPlanMonth(month))}</strong>
            <button class="secondary" type="button" onclick="changePlanMonth(1)" ${canShowNext ? "" : "disabled"}>Следующий месяц →</button>
          </div>
        </div>
        ${state.user.role === "execution" ? `<button class="month-plan-action" onclick="generatePlan()">Собрать план</button>` : ""}
      </div>
      <p>Статус: <span class="badge">${html(plan.status)}</span></p>
      ${plan.reverseMatchCount ? `
        <div class="notice">
          <strong>Обнаружены встречные рейсы:</strong> ${html(plan.reverseMatchCount)}.
          Откройте встречную логистику, чтобы проверить зеркальные маршруты и объединить их в один путевой лист.
          <div class="toolbar" style="margin:10px 0 0">
            <button class="secondary" onclick="go('reverse')">Открыть встречные рейсы</button>
          </div>
        </div>
      ` : ""}
      <section class="aviation-plan">
        <div class="plan-section-heading">
          <h2 class="aviation-plan-title">План использования военно-транспортной авиации ВВС СВО ВС РК на ${html(formatPlanMonth(month))} года</h2>
          ${planExportButtons("aviation", month)}
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr><th rowspan="2" class="plan-select-cell"><input class="plan-select-checkbox" type="checkbox" onchange="togglePlanSelection('aviation', this.checked)" aria-label="Выбрать все авиа-заявки"></th><th rowspan="2">№ п/п</th><th rowspan="2">Дата вылета</th><th rowspan="2">Заявка (в чьих интересах)</th><th rowspan="2">Тип ВС</th><th rowspan="2">Маршрут полета</th><th colspan="2">Перевозимый</th><th rowspan="2">Цель перевозки</th></tr>
              <tr><th>личный состав</th><th>вес груза</th></tr>
            </thead>
            <tbody>${aviationRows || `<tr><td colspan="9">Авиа-заявок в плане пока нет.</td></tr>`}</tbody>
          </table>
        </div>
      </section>
      <section class="plan-section">
        <div class="plan-section-heading">
          <h2 class="aviation-plan-title auto-plan-title"><span>ПЛАН</span>перевозок материально-технических средств автомобильным транспортом ВС РК свыше 200 км на ${html(formatPlanMonth(month))} года</h2>
          ${planExportButtons("auto", month)}
        </div>
        <div class="table-scroll">
          <table class="auto-plan-table">
            <thead>
              <tr>
                <th rowspan="2" class="plan-select-cell"><input class="plan-select-checkbox" type="checkbox" onchange="togglePlanSelection('auto', this.checked)" aria-label="Выбрать все авто-заявки"></th>
                <th rowspan="2">№ п/п</th>
                <th rowspan="2">Заявитель перевозок, в/ч</th>
                <th rowspan="2">Наименование груза и пункт назначения</th>
                <th rowspan="2" class="auto-plan-vertical">Масса (количество) груза, т</th>
                <th rowspan="2">Воинская часть (учреждение), выделяющая автотранспорт</th>
                <th colspan="3">Потребное количество транспортных средств, ед.</th>
                <th colspan="3">Маршрут перевозки (пп., в/ч)</th>
                <th rowspan="2">Плечо подвоза в км и количество рейсов</th>
                <th colspan="2">Срок перевозки</th>
                <th rowspan="2" class="auto-plan-vertical">Расход моторесурсов, км</th>
                <th rowspan="2">Что планируется везти в обратном направлении</th>
                <th rowspan="2">Примечание</th>
              </tr>
              <tr>
                <th class="auto-plan-vertical">грузовых автомобилей</th><th class="auto-plan-vertical">автотопливоцистерн</th><th class="auto-plan-vertical">прицепов</th>
                <th>начальный пункт</th><th>пункты назначения</th><th>конечный пункт</th>
                <th>начало</th><th>конец</th>
              </tr>
            </thead>
            <tbody>${autoRows || `<tr><td colspan="18">Автомобильных заявок в плане пока нет.</td></tr>`}</tbody>
          </table>
        </div>
      </section>
      <section class="plan-section">
        <div class="plan-section-heading">
          <h2 class="aviation-plan-title">Заявка<br>на планирование ____________ воинских перевозок в ____________ 20__ года</h2>
          ${planExportButtons("rail", month)}
        </div>
        <div class="table-scroll">
          <table class="rail-plan-table">
            <thead><tr>
              <th class="plan-select-cell"><input class="plan-select-checkbox" type="checkbox" onchange="togglePlanSelection('rail', this.checked)" aria-label="Выбрать все ЖД-заявки"></th>
              <th>Номера воинских эшелонов (транспортов)</th>
              <th>Наименование и количество перевозимых воинских грузов</th>
              <th>Номера ООН и аварийных карточек опасных грузов</th>
              <th>Степень негабаритности</th>
              <th>Количество личного состава по категориям</th>
              <th>Транспортные средства</th>
              <th>Пункт погрузки (станция, порт, аэропорт)<br>отправитель</th>
              <th>Дата погрузки</th>
              <th>Пункт выгрузки (станция, порт, аэропорт)<br>получатель</th>
              <th>Обеспеченность (потребность) крепёжного материала</th>
              <th>Воинское звание, фамилия и инициалы начальника эшелона (караула), количество л/с, оружия и боеприпасов</th>
              <th>Примечание (тоннаж и прочее)</th>
            </tr></thead>
            <tbody>${railRows || `<tr><td colspan="13">ЖД-заявок в плане пока нет.</td></tr>`}</tbody>
          </table>
        </div>
      </section>
    </div>
  `);
}

function monthIndex(month) {
  const [year, monthNumber] = String(month || "").split("-").map(Number);
  return year * 12 + monthNumber - 1;
}

function monthFromIndex(index) {
  const year = Math.floor(index / 12);
  const monthNumber = index - year * 12 + 1;
  return `${year}-${String(monthNumber).padStart(2, "0")}`;
}

async function changePlanMonth(delta) {
  const currentMonth = todayIso().slice(0, 7);
  const activeMonth = state.planMonth || currentMonth;
  const targetIndex = monthIndex(activeMonth) + Number(delta || 0);
  const currentIndex = monthIndex(currentMonth);
  if (targetIndex < currentIndex - 2 || targetIndex > currentIndex + 2) return;
  state.planMonth = monthFromIndex(targetIndex);
  await renderPlan();
}

function planExportButtons(type, month) {
  return `
    <div class="toolbar plan-export-actions">
      <button class="secondary" type="button" onclick="exportMonthlyPlan('${type}', '${month}', 'csv')">Экспорт CSV</button>
      <button class="secondary" type="button" onclick="exportMonthlyPlan('${type}', '${month}', 'print')">Печать PDF</button>
    </div>
  `;
}

function togglePlanSelection(type, checked) {
  document.querySelectorAll(`.plan-row-checkbox[data-plan-type="${type}"]`).forEach((checkbox) => {
    checkbox.checked = checked;
  });
}

function exportMonthlyPlan(type, month, format) {
  const selectedIds = Array.from(document.querySelectorAll(`.plan-row-checkbox[data-plan-type="${type}"]:checked`)).map((checkbox) => checkbox.value);
  const params = new URLSearchParams({ month, type });
  if (selectedIds.length) params.set("ids", selectedIds.join(","));
  const path = format === "csv" ? "/api/export/monthly-plan.csv" : "/api/export/monthly-plan-print";
  const url = `${path}?${params.toString()}`;
  if (format === "csv") window.location.href = url;
  else window.open(url, "_blank", "noopener");
}

function formatPlanMonth(month) {
  const [year, monthNumber] = String(month || "").split("-");
  const monthNames = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  return `${monthNames[Number(monthNumber) - 1] || month} ${year || ""}`.trim();
}

function formatPlanDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value || "";
}

async function generatePlan() {
  const month = state.planMonth || todayIso().slice(0, 7);
  try {
    await api("/api/monthly-plan/generate", { method: "POST", body: JSON.stringify({ month }) });
    setMessage("Месячный план собран.");
    await renderPlan();
  } catch (error) {
    setMessage("", error.message);
    await renderPlan();
  }
}

async function renderReverse() {
  shell(`<div class="panel"><h1>Встречные рейсы</h1><p>Загрузка...</p></div>`);
  const data = await api("/api/reverse-logistics");
  const canMerge = ["verifier", "execution"].includes(state.user.role);
  const rows = data.matches.map((match) => `
    <tr class="reverse-match">
      <td>${renderRouteNode(match.firstId, match.firstRoute, match.firstDate, "forward")}</td>
      <td class="reverse-link-cell">
        <div class="reverse-link-icon">↔</div>
        <span class="badge warn">±${html(match.dateDeltaDays)} дн.</span>
      </td>
      <td>${renderRouteNode(match.secondId, match.secondRoute, match.secondDate, "backward")}</td>
      <td>
        ${canMerge
          ? `<button onclick="mergeReverse('${match.firstId}', '${match.secondId}')">Объединить в один путевой лист</button>`
          : `<span class="muted">Доступно верификатору и отделу исполнения</span>`}
      </td>
    </tr>
  `).join("");
  shell(`
    <div class="panel">
      <h1>Встречная логистика</h1>
      <p class="muted">Карты не используются. Отображение выполнено как табличный граф направлений.</p>
      <table>
        <thead><tr><th>Направление А -> Б</th><th>Связь</th><th>Направление Б -> А</th><th>Действие</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">Встречные рейсы не найдены.</td></tr>`}</tbody>
      </table>
    </div>
  `);
}

function renderRouteNode(id, route, date, variant) {
  const [from = "", to = ""] = String(route || "").split(" -> ");
  return `
    <div class="route-node ${variant}">
      <div class="route-id">${html(id)}</div>
      <div class="route-line">
        <span class="route-point">${html(from)}</span>
        <span class="route-arrow">→</span>
        <span class="route-point">${html(to)}</span>
      </div>
      <div class="muted">${html(date)}</div>
    </div>
  `;
}

async function mergeReverse(firstId, secondId) {
  try {
    await api("/api/reverse-logistics/merge", { method: "POST", body: JSON.stringify({ firstId, secondId }) });
    setMessage("Встречные рейсы объединены.");
    await renderReverse();
  } catch (error) {
    setMessage("", error.message, 5000);
    await renderReverse();
  }
}

function renderAi() {
  const options = state.applications.map((app) => `<option value="${html(app.id)}">${html(app.id)} - ${html(app.cargoName)}</option>`).join("");
  shell(`
    <div class="panel">
      <h1>Локальный ИИ-ассистент</h1>
      <div class="notice">Модель: Mistral 7B Q4 через Ollama в Docker. При GPU 6GB+ VRAM ответ обычно быстрый; на CPU возможна задержка 2-5 минут. Если Ollama недоступна, используется offline-fallback по MVP-правилам.</div>
      <div class="grid">
        <div class="field"><label>Заявка</label><select id="ai-app">${options}</select></div>
        <div class="field"><label>Действие</label><select id="ai-kind"><option value="validate">Интеллектуальная валидация</option><option value="report">Рапорт</option><option value="summary">Выжимка</option></select></div>
      </div>
      <div class="toolbar" style="margin-top:12px"><button id="ai-run" onclick="runAi()">Сформировать</button></div>
      <div id="ai-output" class="pre"></div>
    </div>
  `);
}

async function runAi() {
  const button = $("#ai-run");
  const output = $("#ai-output");
  if (button) button.disabled = true;
  if (output) output.textContent = "Локальный ИИ обрабатывает заявку. На CPU ответ может занять несколько минут...";
  try {
    const data = await api("/api/ai", {
      method: "POST",
      body: JSON.stringify({ applicationId: $("#ai-app").value, kind: $("#ai-kind").value })
    });
    output.textContent = data.response;
  } catch (error) {
    output.textContent = error.message;
  } finally {
    if (button) button.disabled = false;
  }
}

function renderRefs() {
  shell(`
    <div class="panel">
      <h1>Справочники MVP</h1>
      <h2>Аэродромы</h2>
      <table><thead><tr><th>Код</th><th>Название</th><th>Город</th></tr></thead><tbody>
        ${state.refs.airfields.map((x) => `<tr><td>${html(x.code)}</td><td>${html(x.name)}</td><td>${html(x.city)}</td></tr>`).join("")}
      </tbody></table>
      <h2>Части / точки</h2>
      <table><thead><tr><th>Код</th><th>Название</th><th>Регион</th></tr></thead><tbody>
        ${state.refs.points.map((x) => `<tr><td>${html(x.code)}</td><td>${html(x.name)}</td><td>${html(x.region)}</td></tr>`).join("")}
      </tbody></table>
      <h2>Тарифы</h2>
      <table><thead><tr><th>Тип транспорта</th><th>Цена за км</th></tr></thead><tbody>
        ${state.refs.tariffs.map((t) => `<tr><td>${html(state.transportLabels[t.transportType])}</td><td>${html(t.pricePerKm)}</td></tr>`).join("")}
      </tbody></table>
      <h2>Транспорт</h2>
      <table><thead><tr><th>Тип</th><th>Грузоподъемность, кг</th><th>Количество единиц</th></tr></thead><tbody>
        ${state.refs.vehicleTypes.map((t) => `<tr><td>${html(t.type)}</td><td>${html(t.capacityKg)}</td><td>${html(t.units)}</td></tr>`).join("")}
      </tbody></table>
      <h2>Матрица расстояний</h2>
      <div class="lookup-box">
        <div class="grid">
          <div class="field">
            <label>Тип транспорта</label>
            <select id="distance-transport" onchange="renderDistanceLookup()">
              <option value="auto">Авто</option>
              <option value="rail">ЖД</option>
              <option value="aviation">Авиа</option>
            </select>
          </div>
          <div class="field">
            <label>Точка А / откуда</label>
            <select id="distance-from" onchange="renderDistanceLookup()"></select>
          </div>
          <div class="field">
            <label>Точка Б / куда</label>
            <select id="distance-to" onchange="updateDistanceLookupResult()"></select>
          </div>
        </div>
        <div id="distance-result"></div>
      </div>
      <h2>Календарный конфиг</h2>
      <table><tbody>
        <tr><th>Дедлайн приема заявок</th><td>${html(state.refs.scheduleConfig.requestDeadlineDay)}-е, если выходной - первый рабочий день после</td></tr>
        <tr><th>Авто-сборка плана</th><td>${html(state.refs.scheduleConfig.autoPlanDay)}-е, если выходной - первый рабочий день после</td></tr>
        <tr><th>Блокировка плана</th><td>${html(state.refs.scheduleConfig.planLockDay)}-е, если выходной - первый рабочий день после</td></tr>
      </tbody></table>
    </div>
  `);
  renderDistanceLookup();
}

function distanceItemsForTransport(type) {
  if (type === "aviation") return state.refs.airfields || [];
  if (type === "rail") return state.refs.stations || [];
  return state.refs.points || [];
}

function lookupDistance(from, to, type) {
  const distances = state.refs.distances || [];
  for (let index = distances.length - 1; index >= 0; index -= 1) {
    const item = distances[index];
    if (item.from === from && item.to === to && item.type === type) return item;
  }
  return null;
}

function renderDistanceLookup() {
  const transportSelect = $("#distance-transport");
  const fromSelect = $("#distance-from");
  const toSelect = $("#distance-to");
  if (!transportSelect || !fromSelect || !toSelect) return;
  const type = transportSelect.value || "auto";
  const values = distanceItemsForTransport(type).map(refValue).filter(Boolean);
  const oldFrom = fromSelect.value;
  const oldTo = toSelect.value;
  const from = values.includes(oldFrom) ? oldFrom : values[0] || "";
  const to = values.includes(oldTo) && oldTo !== from ? oldTo : values.find((value) => value !== from) || "";
  fromSelect.innerHTML = values.map((value) => `<option value="${html(value)}" ${value === from ? "selected" : ""}>${html(value)}</option>`).join("");
  toSelect.innerHTML = values.filter((value) => value !== from).map((value) => `<option value="${html(value)}" ${value === to ? "selected" : ""}>${html(value)}</option>`).join("");
  updateDistanceLookupResult();
}

function updateDistanceLookupResult() {
  const target = $("#distance-result");
  const transportSelect = $("#distance-transport");
  const fromSelect = $("#distance-from");
  const toSelect = $("#distance-to");
  if (!target || !transportSelect || !fromSelect || !toSelect) return;
  const type = transportSelect.value;
  const from = fromSelect.value;
  const to = toSelect.value;
  const transport = state.transportLabels[type] || "Транспорт";
  if (!from || !to) {
    target.innerHTML = `<div class="notice compact">Выберите тип транспорта и две разные точки.</div>`;
    return;
  }
  const distance = lookupDistance(from, to, type);
  if (!distance) {
    target.innerHTML = `<div class="error compact">Для маршрута ${html(from)} -> ${html(to)} (${html(transport)}) расстояние не найдено.</div>`;
    return;
  }
  target.innerHTML = `
    <div class="distance-result">
      <div>
        <span class="muted">Маршрут</span>
        <strong>${html(from)} -> ${html(to)}</strong>
      </div>
      <div>
        <span class="muted">Тип</span>
        <strong>${html(transport)}</strong>
      </div>
      <div>
        <span class="muted">Километраж</span>
        <strong>${html(distance.km)} км</strong>
      </div>
    </div>
  `;
}

async function renderAdmin() {
  shell(`<div class="panel"><h1>Админ-панель</h1><p>Загрузка...</p></div>`);
  try {
    const data = await api("/api/admin/users");
    const users = data.users;
    shell(`
      <div class="panel">
        <h1>Админ-панель</h1>
        <div class="notice">Пользователь создается с одной ролью. Бизнес-роли: Инициатор, Оператор, Верификатор, Отдел исполнения.</div>
        <h2>Пользователи</h2>
        <table>
          <thead><tr><th>Логин</th><th>Имя</th><th>Роль</th><th>Подразделение</th></tr></thead>
          <tbody>${users.map((u) => `<tr><td>${html(u.username)}</td><td>${html(u.name)}</td><td>${html(u.roleLabel)}</td><td>${html(u.unit)}</td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="panel">
        <h2>Создать пользователя</h2>
        <form id="user-form" class="grid" onsubmit="createUser(event)">
          <div class="field"><label>Логин</label><input name="username" required></div>
          <div class="field"><label>Пароль</label><input name="password" type="password" minlength="12" autocomplete="new-password" placeholder="Не менее 12 символов" required></div>
          <div class="field"><label>Имя / ФИО</label><input name="name" required></div>
          <div class="field"><label>Подразделение</label><input name="unit"></div>
          <div class="field"><label>Роль</label><select name="role">
            <option value="initiator">Инициатор</option>
            <option value="operator">Оператор части</option>
            <option value="verifier">Верификатор</option>
            <option value="execution">Отдел исполнения</option>
          </select></div>
          <div class="field"><label>&nbsp;</label><button>Создать</button></div>
        </form>
      </div>
      <div class="panel">
        <h2>Добавить справочник вручную</h2>
        <form id="ref-form" class="grid" onsubmit="addRef(event)">
          <div class="field"><label>Тип</label><select name="type" id="ref-type" onchange="renderRefInputs()">
            <option value="airfield">Аэродром</option>
            <option value="point">Часть / точка</option>
            <option value="distance">Маршрут и расстояние</option>
            <option value="tariff">Тариф</option>
            <option value="vehicle">Транспорт</option>
          </select></div>
          <div id="ref-inputs" class="grid field full"></div>
          <div class="field"><label>&nbsp;</label><button>Добавить</button></div>
        </form>
      </div>
      <div class="panel">
        <h2>Импорт справочника CSV</h2>
        <p class="muted">Поддерживаются разделители запятая или точка с запятой. Примеры заголовков: airfield: code,name,city; point: code,name,region; distance: from,to,km,type; tariff: transportType,pricePerKm; vehicle: type,capacityKg,units.</p>
        <form id="csv-form" onsubmit="importCsv(event)">
          <div class="grid">
            <div class="field"><label>Тип справочника</label><select name="type">
              <option value="airfield">Аэродромы</option>
              <option value="point">Части / точки</option>
              <option value="distance">Маршруты и расстояния</option>
              <option value="tariff">Тарифы</option>
              <option value="vehicle">Транспорт</option>
            </select></div>
            <div class="field full"><label>CSV</label><textarea name="csv" placeholder="code;name;city&#10;ABC;Аэродром ABC;Город"></textarea></div>
          </div>
          <div class="toolbar"><button>Импортировать CSV</button></div>
        </form>
      </div>
    `);
    renderRefInputs();
  } catch (error) {
    setMessage("", error.message);
    shell(`<div class="panel"><h1>Админ-панель</h1><p class="error">${html(error.message)}</p></div>`);
  }
}

function renderRefInputs() {
  const type = $("#ref-type")?.value;
  const target = $("#ref-inputs");
  if (!target) return;
  if (type === "airfield") {
    target.innerHTML = `<div class="field"><label>Код *</label><input name="code" required></div><div class="field"><label>Название *</label><input name="name" required></div><div class="field"><label>Город</label><input name="city"></div>`;
  } else if (type === "point") {
    target.innerHTML = `<div class="field"><label>Код *</label><input name="code" required></div><div class="field"><label>Название *</label><input name="name" required></div><div class="field"><label>Регион</label><input name="region"></div>`;
  } else if (type === "distance") {
    target.innerHTML = `<div class="field"><label>Точка А *</label><input name="from" required></div><div class="field"><label>Точка Б *</label><input name="to" required></div><div class="field"><label>Км *</label><input name="km" type="number" min="1" step="0.1" required></div><div class="field"><label>Тип</label><select name="transportType"><option value="auto">Авто</option><option value="rail">ЖД</option><option value="aviation">Авиа</option></select></div>`;
  } else if (type === "tariff") {
    target.innerHTML = `<div class="field"><label>Тип</label><select name="transportType"><option value="auto">Авто</option><option value="rail">ЖД</option><option value="aviation">Авиа</option></select></div><div class="field"><label>Цена за км *</label><input name="pricePerKm" type="number" min="0.01" step="0.01" required></div>`;
  } else {
    target.innerHTML = `<div class="field"><label>Тип транспорта *</label><input name="vehicleType" required></div><div class="field"><label>Грузоподъемность, кг *</label><input name="capacityKg" type="number" min="1" step="0.1" required></div><div class="field"><label>Количество единиц *</label><input name="units" type="number" min="0" step="1" required></div>`;
  }
}

async function createUser(event) {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData($("#user-form")).entries());
    await api("/api/admin/users", { method: "POST", body: JSON.stringify(body) });
    setMessage("Пользователь создан.");
    await renderAdmin();
  } catch (error) {
    setMessage("", error.message);
    await renderAdmin();
  }
}

async function addRef(event) {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData($("#ref-form")).entries());
    await api("/api/admin/refs", { method: "POST", body: JSON.stringify(body) });
    const data = await api("/api/bootstrap");
    state.refs = data.refs;
    setMessage("Справочник обновлен.");
    await renderAdmin();
  } catch (error) {
    setMessage("", error.message);
    await renderAdmin();
  }
}

async function importCsv(event) {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData($("#csv-form")).entries());
    const result = await api("/api/admin/import-csv", { method: "POST", body: JSON.stringify(body) });
    const data = await api("/api/bootstrap");
    state.refs = data.refs;
    setMessage(`CSV импортирован: ${result.imported} строк.`);
    await renderAdmin();
  } catch (error) {
    setMessage("", error.message);
    await renderAdmin();
  }
}

init();
