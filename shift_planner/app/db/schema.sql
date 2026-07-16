CREATE TABLE IF NOT EXISTS dp_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ha_user_id VARCHAR(64) UNIQUE,
  username VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  vacation_budget INTEGER DEFAULT 30,
  vacation_base INTEGER DEFAULT 30,
  bundesland VARCHAR(10) DEFAULT 'BY',
  work_days VARCHAR(7) DEFAULT '1111100',
  weekly_hours DECIMAL(5,2) DEFAULT 40,
  is_admin INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dp_shift_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES dp_users(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  short_name VARCHAR(10) NOT NULL,
  color VARCHAR(7) NOT NULL DEFAULT '#4f8ef7',
  default_start TIME,
  default_end TIME,
  counts_as_work INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS dp_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES dp_users(id) ON DELETE CASCADE,
  shift_type_id INTEGER REFERENCES dp_shift_types(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  actual_start TIME,
  actual_end TIME,
  note TEXT,
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS dp_vacations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES dp_users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'geplant',
  note TEXT,
  year INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dp_work_times (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES dp_users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  break_minutes INTEGER DEFAULT 0,
  planned_hours DECIMAL(4,2),
  actual_hours DECIMAL(4,2),
  is_vacation INTEGER DEFAULT 0,
  work_type VARCHAR(30) DEFAULT 'work',
  note TEXT,
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS dp_vacation_carryover (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES dp_users(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  carryover INTEGER DEFAULT 0,
  UNIQUE(user_id, year)
);

CREATE TABLE IF NOT EXISTS dp_holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(100) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'ferien',
  bundesland VARCHAR(10),
  year INTEGER NOT NULL
);
