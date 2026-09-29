


CREATE TABLE location_points (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,             -- telegram | web | wechat
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy REAL,
  live INTEGER NOT NULL DEFAULT 0,  
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_lp_ws ON location_points(workspace_id, created_at DESC);


CREATE TABLE saved_places (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  label TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_m REAL NOT NULL DEFAULT 150,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, label)
);


CREATE TABLE location_triggers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('enter','leave')),
  place_id TEXT,                    
  lat REAL,
  lng REAL,
  radius_m REAL DEFAULT 150,        
  message TEXT NOT NULL,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  context_token TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  inside INTEGER NOT NULL DEFAULT 0,  
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_lt_ws ON location_triggers(workspace_id, enabled);
