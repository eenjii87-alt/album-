-- Нэг гэр бүлийн хувилбараас олон гэр бүлийн хувилбар руу шилжүүлэх (нэг удаа).
-- __SID__ = эзний гэр бүлийн шинэ дугаар, __OWNER__ = эзний имэйл, __NOW__ = одоогийн ms.
CREATE TABLE IF NOT EXISTS accounts (email TEXT PRIMARY KEY, name TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, created INTEGER NOT NULL, drive TEXT);
CREATE TABLE IF NOT EXISTS members (space TEXT NOT NULL, email TEXT NOT NULL, name TEXT, roles TEXT NOT NULL, added INTEGER, PRIMARY KEY (space, email));
CREATE INDEX IF NOT EXISTS members_email ON members (email);
CREATE TABLE IF NOT EXISTS sdocs (space TEXT NOT NULL, app TEXT NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (space, app, path));
CREATE INDEX IF NOT EXISTS sdocs_parent ON sdocs (space, app, parent);
CREATE TABLE IF NOT EXISTS scols (space TEXT NOT NULL, app TEXT NOT NULL, parent TEXT NOT NULL, ver INTEGER NOT NULL, PRIMARY KEY (space, app, parent));
ALTER TABLE assets ADD COLUMN space TEXT;
ALTER TABLE assets ADD COLUMN store TEXT;
ALTER TABLE assets ADD COLUMN ref TEXT;
CREATE INDEX IF NOT EXISTS assets_space ON assets (space);
INSERT OR IGNORE INTO spaces (id, name, owner, created) VALUES ('__SID__', COALESCE((SELECT json_extract(data, '$.title') FROM docs WHERE app = 'album' AND path = 'meta/site'), 'Манай гэр бүл'), '__OWNER__', __NOW__);
INSERT OR IGNORE INTO members (space, email, name, roles, added) VALUES ('__SID__', '__OWNER__', COALESCE((SELECT v FROM config WHERE k = 'owner_name'), '__OWNERNAME__'), 'owner', 0);
INSERT OR IGNORE INTO members (space, email, name, roles, added) SELECT '__SID__', email, name, roles, added FROM users;
INSERT OR IGNORE INTO accounts (email, name, created) VALUES ('__OWNER__', COALESCE((SELECT v FROM config WHERE k = 'owner_name'), '__OWNERNAME__'), __NOW__);
INSERT OR IGNORE INTO accounts (email, name, created) SELECT email, name, COALESCE(added, __NOW__) FROM users;
INSERT OR IGNORE INTO sdocs (space, app, path, parent, data, updated) SELECT '__SID__', app, path, parent, data, updated FROM docs;
INSERT OR IGNORE INTO scols (space, app, parent, ver) SELECT '__SID__', app, parent, ver FROM cols;
UPDATE assets SET space = '__SID__', store = 'kv' WHERE space IS NULL;
INSERT OR REPLACE INTO config (k, v) VALUES ('kv_space', '__SID__');
INSERT OR REPLACE INTO config (k, v) VALUES ('log_space', '__SID__');
