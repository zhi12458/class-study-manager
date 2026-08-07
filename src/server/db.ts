import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPasswordHash } from "./auth.js";

export function getDefaultDbPath(): string {
  return process.env.DB_PATH ?? path.join(process.cwd(), "data", "class-study.sqlite");
}

export function openDatabase(dbPath = getDefaultDbPath()): DatabaseSync {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("pragma journal_mode = WAL");
  db.exec("pragma foreign_keys = ON");
  db.exec("pragma busy_timeout = 5000");
  runMigrations(db);
  seedAdmin(db);
  return db;
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      applied_at text not null default current_timestamp
    );
  `);
  const applied = new Set(
    (db.prepare("select version from schema_migrations").all() as Array<{ version: number }>).map((row) => row.version)
  );
  if (!applied.has(1)) migrationOne(db);
  if (!applied.has(2)) migrationTwo(db);
  if (!applied.has(3)) migrationThree(db);
}

function migrationOne(db: DatabaseSync): void {
  db.exec("begin immediate");
  try {
    db.exec(`
      create table persons (
        id integer primary key autoincrement,
        name text not null,
        dharma_name text,
        phone text not null unique,
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp
      );

      create table users (
        id integer primary key autoincrement,
        person_id integer unique references persons(id),
        username text not null unique,
        password_hash text not null,
        display_name text not null,
        is_admin integer not null default 0 check(is_admin in (0, 1)),
        can_counsel integer not null default 0 check(can_counsel in (0, 1)),
        active integer not null default 1 check(active in (0, 1)),
        must_change_password integer not null default 1 check(must_change_password in (0, 1)),
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp
      );

      create table classes (
        id integer primary key autoincrement,
        name text not null,
        counselor_user_id integer not null references users(id),
        cadence_mode text not null default 'same_week' check(cadence_mode in ('same_week', 'parallel_two_week')),
        archived integer not null default 0 check(archived in (0, 1)),
        created_by integer not null references users(id),
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp
      );
      create unique index classes_active_name_unique on classes(lower(trim(name))) where archived = 0;

      create table groups (
        id integer primary key autoincrement,
        class_id integer not null references classes(id) on delete cascade,
        name text not null,
        sort_order integer not null,
        active integer not null default 1 check(active in (0, 1)),
        created_at text not null default current_timestamp,
        archived_at text
      );
      create unique index groups_active_name_unique on groups(class_id, lower(trim(name))) where active = 1;

      create table enrollments (
        id integer primary key autoincrement,
        class_id integer not null references classes(id) on delete cascade,
        person_id integer not null references persons(id),
        note text,
        active_from_sequence integer not null,
        inactive_from_sequence integer,
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp,
        unique(class_id, person_id),
        check(inactive_from_sequence is null or inactive_from_sequence > active_from_sequence)
      );

      create table group_assignments (
        id integer primary key autoincrement,
        enrollment_id integer not null references enrollments(id) on delete cascade,
        group_id integer not null references groups(id),
        effective_from_sequence integer not null,
        effective_to_sequence integer,
        created_at text not null default current_timestamp,
        check(effective_to_sequence is null or effective_to_sequence > effective_from_sequence)
      );
      create unique index group_assignment_start_unique on group_assignments(enrollment_id, effective_from_sequence);

      create table lessons (
        id integer primary key autoincrement,
        class_id integer not null references classes(id) on delete cascade,
        sequence integer not null,
        title text not null,
        lesson_type text not null default 'regular' check(lesson_type in ('regular', 'review')),
        cadence_mode text not null check(cadence_mode in ('same_week', 'parallel_two_week')),
        outline_due_date text not null,
        group_study_due_date text not null,
        class_study_due_date text not null,
        roster_frozen_at text,
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp,
        unique(class_id, sequence)
      );

      create table schedule_breaks (
        id integer primary key autoincrement,
        class_id integer not null references classes(id) on delete cascade,
        start_date text not null,
        weeks integer not null default 1 check(weeks between 1 and 52),
        reason text not null default '放假/暂停',
        created_by integer not null references users(id),
        created_at text not null default current_timestamp
      );

      create table lesson_roster (
        id integer primary key autoincrement,
        lesson_id integer not null references lessons(id) on delete cascade,
        enrollment_id integer not null references enrollments(id),
        student_name text not null,
        dharma_name text,
        group_id integer not null references groups(id),
        group_name text not null,
        unique(lesson_id, enrollment_id)
      );

      create table attendance_entries (
        id integer primary key autoincrement,
        lesson_id integer not null references lessons(id) on delete cascade,
        lesson_roster_id integer not null references lesson_roster(id) on delete cascade,
        metric text not null check(metric in ('outline', 'group_study', 'class_study')),
        status text not null check(status in (
          'yes', 'no', 'not_required', 'present', 'absent',
          'onsite', 'online', 'makeup', 'share'
        )),
        modified_by integer not null references users(id),
        modified_at text not null default current_timestamp,
        unique(lesson_roster_id, metric)
      );

      create table attendance_audit (
        id integer primary key autoincrement,
        lesson_id integer not null references lessons(id) on delete cascade,
        lesson_roster_id integer not null references lesson_roster(id) on delete cascade,
        metric text not null,
        previous_status text,
        new_status text,
        modified_by integer not null references users(id),
        modified_at text not null default current_timestamp
      );

      create table class_monitors (
        class_id integer primary key references classes(id) on delete cascade,
        enrollment_id integer not null unique references enrollments(id),
        user_id integer not null unique references users(id),
        assigned_by integer not null references users(id),
        assigned_at text not null default current_timestamp
      );

      create table sessions_auth (
        id integer primary key autoincrement,
        token_hash text not null unique,
        user_id integer not null references users(id) on delete cascade,
        expires_at text not null,
        created_at text not null default current_timestamp
      );

      create index lessons_class_due_idx on lessons(class_id, class_study_due_date);
      create index enrollments_class_idx on enrollments(class_id);
      create index attendance_lesson_idx on attendance_entries(lesson_id);
    `);
    db.prepare("insert into schema_migrations (version) values (1)").run();
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function migrationTwo(db: DatabaseSync): void {
  db.exec("begin immediate");
  try {
    db.exec(`
      alter table users add column counselor_role integer not null default 0 check(counselor_role in (0, 1));
      update users
         set counselor_role = 1
       where can_counsel = 1
          or id in (select counselor_user_id from classes);
      insert into schema_migrations (version) values (2);
    `);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function migrationThree(db: DatabaseSync): void {
  db.exec("begin immediate");
  try {
    db.exec(`
      create table class_counselor_history (
        id integer primary key autoincrement,
        class_id integer not null references classes(id) on delete cascade,
        counselor_user_id integer not null references users(id),
        assigned_by integer not null references users(id),
        assigned_at text not null default current_timestamp,
        ended_at text
      );
      insert into class_counselor_history (class_id, counselor_user_id, assigned_by, assigned_at)
      select id, counselor_user_id, created_by, created_at from classes;
      create index class_counselor_history_user_idx on class_counselor_history(counselor_user_id);
      insert into schema_migrations (version) values (3);
    `);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function seedAdmin(db: DatabaseSync): void {
  const exists = db.prepare("select id from users where is_admin = 1 limit 1").get();
  if (exists) return;
  const username = process.env.ADMIN_USERNAME?.trim() || "admin";
  const password = process.env.ADMIN_PASSWORD || "admin12345";
  if (process.env.NODE_ENV === "production" && !process.env.ADMIN_PASSWORD) {
    throw new Error("生产环境必须设置 ADMIN_PASSWORD");
  }
  db.prepare(
    `insert into users
       (username, password_hash, display_name, is_admin, can_counsel, active, must_change_password)
     values (?, ?, '系统管理员', 1, 0, 1, ?)`
  ).run(username, createPasswordHash(password), process.env.ADMIN_PASSWORD ? 1 : 0);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn("Development admin account: admin / admin12345");
  }
}
