begin;

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists app_meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  username text not null unique,
  password_hash text not null,
  role text not null check (role in ('admin', 'initiator', 'operator', 'verifier', 'execution')),
  name text not null,
  unit text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ref_urgency (
  name text primary key,
  sort_order integer not null default 0
);

create table if not exists ref_transport_types (
  code text primary key,
  label text not null
);

create table if not exists ref_airfields (
  code text primary key,
  name text not null unique,
  city text not null default ''
);

create table if not exists ref_stations (
  name text primary key
);

create table if not exists ref_points (
  code text primary key,
  name text not null unique,
  region text not null default ''
);

create table if not exists ref_wagon_types (
  name text primary key
);

create table if not exists ref_truck_types (
  name text primary key
);

create table if not exists ref_vehicle_types (
  type text primary key,
  capacity_kg numeric(12, 2) not null default 0,
  units integer not null default 0
);

create table if not exists ref_tariffs (
  id text primary key,
  transport_type text not null references ref_transport_types(code),
  price_per_km numeric(14, 2) not null default 0,
  days_base integer not null default 1,
  note text not null default ''
);

create table if not exists ref_distances (
  id bigserial primary key,
  from_point text not null,
  to_point text not null,
  transport_type text not null references ref_transport_types(code),
  km numeric(12, 2) not null check (km >= 0),
  source text not null default '',
  unique (from_point, to_point, transport_type)
);

create table if not exists schedule_config (
  id boolean primary key default true check (id),
  request_deadline_day integer not null check (request_deadline_day between 1 and 31),
  auto_plan_day integer not null check (auto_plan_day between 1 and 31),
  plan_lock_day integer not null check (plan_lock_day between 1 and 31),
  weekend_policy text not null default 'next_working_day',
  note text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists applications (
  id text primary key check (id ~ '^[1-9][0-9]{0,3}$'),
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text references users(id),
  unit text not null default '',
  transport_type text not null references ref_transport_types(code),
  urgency text not null references ref_urgency(name),
  origin text not null,
  destination text not null,
  planned_date date not null,
  cargo_name text not null,
  cargo_category text not null default '',
  weight_kg numeric(14, 2) not null default 0,
  place_weight_kg numeric(14, 2) not null default 0,
  volume_m3 numeric(14, 2) not null default 0,
  places integer not null default 0,
  dimensions text not null default '',
  sender text not null default '',
  recipient text not null default '',
  justification text not null default '',
  comment text not null default '',
  linked_return_application_id text references applications(id),
  auto jsonb not null default '{}'::jsonb,
  rail jsonb not null default '{}'::jsonb,
  aviation jsonb not null default '{}'::jsonb,
  calculation jsonb not null default '{}'::jsonb,
  constraint applications_weight_nonnegative check (weight_kg >= 0),
  constraint applications_place_weight_nonnegative check (place_weight_kg >= 0),
  constraint applications_volume_nonnegative check (volume_m3 >= 0),
  constraint applications_places_nonnegative check (places >= 0)
);

create index if not exists applications_status_idx on applications(status);
create index if not exists applications_created_by_idx on applications(created_by);
create index if not exists applications_planned_date_idx on applications(planned_date);
create index if not exists applications_route_idx on applications(origin, destination, transport_type, planned_date);

create table if not exists application_logs (
  id bigserial primary key,
  application_id text not null references applications(id) on delete cascade,
  at timestamptz not null default now(),
  user_id text references users(id),
  user_name text not null default '',
  role text not null default '',
  action text not null,
  from_status text not null default '',
  to_status text not null default '',
  comment text not null default ''
);

create index if not exists application_logs_application_id_idx on application_logs(application_id);
create index if not exists application_logs_at_idx on application_logs(at);

create table if not exists monthly_plans (
  id text primary key,
  month text not null unique,
  status text not null,
  generated_at timestamptz not null default now(),
  locked_at timestamptz,
  payload jsonb not null default '{}'::jsonb
);

create table if not exists monthly_plan_entries (
  id bigserial primary key,
  plan_id text not null references monthly_plans(id) on delete cascade,
  application_id text references applications(id),
  date date,
  route text not null default '',
  transport_type text references ref_transport_types(code),
  cargo_name text not null default '',
  weight_kg numeric(14, 2) not null default 0,
  trips integer not null default 1,
  distance_km numeric(12, 2) not null default 0,
  motor_resource_km numeric(14, 2) not null default 0,
  cost numeric(14, 2) not null default 0,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists monthly_plan_entries_plan_id_idx on monthly_plan_entries(plan_id);
create index if not exists monthly_plan_entries_application_id_idx on monthly_plan_entries(application_id);

create table if not exists monthly_plan_logs (
  id bigserial primary key,
  plan_id text not null references monthly_plans(id) on delete cascade,
  at timestamptz not null default now(),
  user_id text references users(id),
  user_name text not null default '',
  role text not null default '',
  action text not null,
  comment text not null default ''
);

create table if not exists notifications (
  id bigserial primary key,
  user_id text references users(id),
  message text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists notifications_user_id_idx on notifications(user_id);
create index if not exists notifications_created_at_idx on notifications(created_at);

insert into schema_migrations(version)
values ('001_schema')
on conflict (version) do nothing;

commit;
