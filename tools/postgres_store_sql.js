const transportLabels = {
  aviation: "Авиа",
  rail: "ЖД",
  auto: "Авто"
};

function q(value) {
  if (value === undefined || value === null || value === "") return "null";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function qText(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function qJson(value) {
  return `${q(JSON.stringify(value ?? {}))}::jsonb`;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(fallback);
}

function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : String(fallback);
}

function dateValue(value) {
  return value ? q(value) : "null";
}

function timestampValue(value) {
  return value ? q(value) : "now()";
}

function pushInsert(lines, table, columns, values) {
  lines.push(`insert into ${table} (${columns.join(", ")}) values (${values.join(", ")});`);
}

function buildSql(store) {
  const lines = [
    "begin;",
    "set constraints all deferred;",
    [
      "truncate table",
      [
        "notifications",
        "monthly_plan_logs",
        "monthly_plan_entries",
        "monthly_plans",
        "application_logs",
        "applications",
        "ref_distances",
        "ref_tariffs",
        "ref_vehicle_types",
        "ref_truck_types",
        "ref_wagon_types",
        "ref_points",
        "ref_stations",
        "ref_airfields",
        "ref_transport_types",
        "ref_urgency",
        "schedule_config",
        "app_meta",
        "users"
      ].join(", "),
      "restart identity cascade;"
    ].join(" ")
  ];

  pushInsert(lines, "app_meta", ["key", "value"], [q("meta"), qJson(store.meta || {})]);

  (store.refs?.urgency || []).forEach((name, index) => {
    pushInsert(lines, "ref_urgency", ["name", "sort_order"], [q(name), int(index + 1)]);
  });

  (store.refs?.transportTypes || []).forEach((code) => {
    pushInsert(lines, "ref_transport_types", ["code", "label"], [q(code), q(transportLabels[code] || code)]);
  });

  (store.users || []).forEach((user) => {
    pushInsert(lines, "users", [
      "id", "username", "password_hash", "role", "name", "unit", "created_at", "updated_at"
    ], [
      q(user.id),
      q(user.username),
      q(user.passwordHash || ""),
      q(user.role),
      q(user.name),
      qText(user.unit),
      "now()",
      "now()"
    ]);
  });

  (store.refs?.airfields || []).forEach((item) => {
    pushInsert(lines, "ref_airfields", ["code", "name", "city"], [q(item.code), q(item.name), qText(item.city)]);
  });

  (store.refs?.stations || []).forEach((name) => {
    pushInsert(lines, "ref_stations", ["name"], [q(name)]);
  });

  (store.refs?.points || []).forEach((item) => {
    pushInsert(lines, "ref_points", ["code", "name", "region"], [q(item.code), q(item.name), qText(item.region)]);
  });

  (store.refs?.wagonTypes || []).forEach((name) => {
    pushInsert(lines, "ref_wagon_types", ["name"], [q(name)]);
  });

  (store.refs?.truckTypes || []).forEach((name) => {
    pushInsert(lines, "ref_truck_types", ["name"], [q(name)]);
  });

  (store.refs?.vehicleTypes || []).forEach((item) => {
    pushInsert(lines, "ref_vehicle_types", ["type", "capacity_kg", "units"], [
      q(item.type),
      num(item.capacityKg),
      int(item.units)
    ]);
  });

  (store.refs?.tariffs || []).forEach((item) => {
    pushInsert(lines, "ref_tariffs", ["id", "transport_type", "price_per_km", "days_base", "note"], [
      q(item.id),
      q(item.transportType),
      num(item.pricePerKm),
      int(item.daysBase, 1),
      qText(item.note)
    ]);
  });

  (store.refs?.distances || []).forEach((item) => {
    pushInsert(lines, "ref_distances", ["from_point", "to_point", "transport_type", "km", "source"], [
      q(item.from),
      q(item.to),
      q(item.type),
      num(item.km),
      qText(item.source)
    ]);
  });

  const schedule = store.refs?.scheduleConfig || {};
  pushInsert(lines, "schedule_config", [
    "id", "request_deadline_day", "auto_plan_day", "plan_lock_day", "weekend_policy", "note", "updated_at"
  ], [
    "true",
    int(schedule.requestDeadlineDay, 20),
    int(schedule.autoPlanDay, 21),
    int(schedule.planLockDay, 25),
    qText(schedule.weekendPolicy || "next_working_day"),
    qText(schedule.note),
    "now()"
  ]);

  (store.applications || []).forEach((app) => {
    pushInsert(lines, "applications", [
      "id",
      "status",
      "created_at",
      "updated_at",
      "created_by",
      "unit",
      "transport_type",
      "urgency",
      "origin",
      "destination",
      "planned_date",
      "cargo_name",
      "cargo_category",
      "weight_kg",
      "place_weight_kg",
      "volume_m3",
      "places",
      "dimensions",
      "sender",
      "recipient",
      "justification",
      "comment",
      "linked_return_application_id",
      "auto",
      "rail",
      "aviation",
      "calculation"
    ], [
      q(app.id),
      q(app.status),
      timestampValue(app.createdAt),
      timestampValue(app.updatedAt || app.createdAt),
      q(app.createdBy),
      qText(app.unit),
      q(app.transportType),
      q(app.urgency),
      q(app.origin),
      q(app.destination),
      dateValue(app.plannedDate),
      q(app.cargoName),
      qText(app.cargoCategory),
      num(app.weightKg),
      num(app.placeWeightKg),
      num(app.volumeM3),
      int(app.places),
      qText(app.dimensions),
      qText(app.sender),
      qText(app.recipient),
      qText(app.justification),
      qText(app.comment),
      "null",
      qJson(app.auto || {}),
      qJson(app.rail || {}),
      qJson(app.aviation || {}),
      qJson(app.calculation || {})
    ]);
  });

  (store.applications || []).forEach((app) => {
    if (app.linkedReturnApplicationId) {
      lines.push(`update applications set linked_return_application_id = ${q(app.linkedReturnApplicationId)} where id = ${q(app.id)};`);
    }
  });

  (store.applications || []).forEach((app) => {
    (app.log || []).forEach((item) => {
      pushInsert(lines, "application_logs", [
        "application_id", "at", "user_id", "user_name", "role", "action", "from_status", "to_status", "comment"
      ], [
        q(app.id),
        timestampValue(item.at),
        q(item.userId),
        qText(item.userName),
        qText(item.role),
        q(item.action),
        qText(item.fromStatus),
        qText(item.toStatus),
        qText(item.comment)
      ]);
    });
  });

  (store.monthlyPlans || []).forEach((plan) => {
    pushInsert(lines, "monthly_plans", ["id", "month", "status", "generated_at", "locked_at", "payload"], [
      q(plan.id),
      q(plan.month),
      q(plan.status),
      timestampValue(plan.generatedAt),
      plan.lockedAt ? q(plan.lockedAt) : "null",
      qJson(plan)
    ]);

    (plan.entries || []).forEach((entry) => {
      pushInsert(lines, "monthly_plan_entries", [
        "plan_id",
        "application_id",
        "date",
        "route",
        "transport_type",
        "cargo_name",
        "weight_kg",
        "trips",
        "distance_km",
        "motor_resource_km",
        "cost",
        "payload"
      ], [
        q(plan.id),
        q(entry.applicationId),
        dateValue(entry.date),
        qText(entry.route),
        q(entry.transportType),
        qText(entry.cargoName),
        num(entry.weightKg),
        int(entry.trips, 1),
        num(entry.distanceKm),
        num(entry.motorResourceKm),
        num(entry.cost),
        qJson(entry)
      ]);
    });

    (plan.log || []).forEach((item) => {
      pushInsert(lines, "monthly_plan_logs", ["plan_id", "at", "user_id", "user_name", "role", "action", "comment"], [
        q(plan.id),
        timestampValue(item.at),
        q(item.userId),
        qText(item.userName),
        qText(item.role),
        q(item.action),
        qText(item.comment)
      ]);
    });
  });

  (store.notifications || []).forEach((item) => {
    pushInsert(lines, "notifications", ["user_id", "message", "created_at", "payload"], [
      q(item.userId),
      q(item.message),
      timestampValue(item.at || item.createdAt),
      qJson(item)
    ]);
  });

  lines.push("commit;");
  return `${lines.join("\n")}\n`;
}

module.exports = { buildSql };
