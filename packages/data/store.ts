import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Dataset, Fact, Settings, SourceStatus } from '../metrics/types.js';
import { dateKey, DAY } from '../metrics/types.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (
        scope TEXT NOT NULL, source TEXT NOT NULL, id TEXT NOT NULL, day TEXT NOT NULL,
        json TEXT NOT NULL, PRIMARY KEY(scope, source, id)
      );
      CREATE INDEX IF NOT EXISTS facts_window ON facts(scope, source, day);
      CREATE TABLE IF NOT EXISTS sources (
        scope TEXT NOT NULL, source TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(scope,source)
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        scope TEXT NOT NULL, source TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(scope,source,day)
      );
      INSERT OR IGNORE INTO migrations VALUES(1);
    `);
  }
  settings(): Settings {
    const row = this.db.prepare('SELECT json FROM settings WHERE id=1').get();
    return row ? JSON.parse(String(row.json)) as Settings : { scopes: [] };
  }
  saveSettings(settings: Settings) {
    this.db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(settings));
  }
  removeScope(scope: string) {
    this.removeScopes([scope]);
  }
  removeScopes(scopes: string[]) {
    this.transaction(() => {
      for (const table of ['facts', 'sources', 'checkpoints']) {
        const statement = this.db.prepare(`DELETE FROM ${table} WHERE scope=?`);
        for (const scope of scopes) statement.run(scope);
      }
      this.saveSettings({ scopes: this.settings().scopes.filter(s => !scopes.includes(s.id)) });
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  put(scope: string, fact: Fact) {
    this.db.prepare('INSERT INTO facts VALUES(?,?,?,?,?) ON CONFLICT(scope,source,id) DO UPDATE SET day=excluded.day,json=excluded.json')
      .run(scope, fact.source, fact.id, fact.day, JSON.stringify(fact.data));
  }
  putMany(scope: string, facts: Fact[]) { this.transaction(() => { for (const fact of facts) this.put(scope, fact); }); }
  removeFact(scope: string, source: string, id: string) {
    this.db.prepare('DELETE FROM facts WHERE scope=? AND source=? AND id=?').run(scope, source, id);
  }
  status(scope: string, status: SourceStatus) {
    this.db.prepare('INSERT INTO sources VALUES(?,?,?) ON CONFLICT(scope,source) DO UPDATE SET json=excluded.json')
      .run(scope, status.source, JSON.stringify(status));
  }
  checkpoint(scope: string, source: string, day: string) {
    this.db.prepare('INSERT OR IGNORE INTO checkpoints VALUES(?,?,?)').run(scope, source, day);
  }
  hasCheckpoint(scope: string, source: string, day: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM checkpoints WHERE scope=? AND source=? AND day=?').get(scope, source, day));
  }
  replaceDay(scope: string, source: string, day: string, facts: Fact[]) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM facts WHERE scope=? AND source=? AND day=?').run(scope, source, day);
      for (const fact of facts) this.put(scope, fact);
      this.checkpoint(scope, source, day);
    });
  }
  dataset(scope: string): Dataset {
    return {
      facts: this.db.prepare('SELECT source,id,day,json FROM facts WHERE scope=?').all(scope).map(row => ({
        source: String(row.source), id: String(row.id), day: String(row.day),
        data: JSON.parse(String(row.json)) as Record<string, unknown>,
      })),
      statuses: this.db.prepare('SELECT json FROM sources WHERE scope=?').all(scope).map(row => JSON.parse(String(row.json)) as SourceStatus),
    };
  }
  prune(scope: string, now = Date.now()) {
    const githubCutoff = dateKey(now - 90 * DAY);
    const copilotCutoff = dateKey(now - 28 * DAY);
    this.transaction(() => {
      // Open PRs/issues are baseline evidence, even if created before the retention window.
      this.db.prepare(`DELETE FROM facts WHERE scope=? AND day<? AND source NOT IN ('surveys','observation','pulls','issues')`).run(scope, githubCutoff);
      this.db.prepare(`DELETE FROM facts WHERE scope=? AND day<? AND source IN ('copilot','users','teams','repoCopilot','copilotWindow')`).run(scope, copilotCutoff);
      this.db.prepare(`DELETE FROM facts WHERE scope=? AND source IN ('pulls','issues') AND json_extract(json,'$.closed_at') IS NOT NULL AND substr(json_extract(json,'$.closed_at'),1,10)<?`).run(scope, githubCutoff);
      this.db.prepare('DELETE FROM checkpoints WHERE scope=? AND day<?').run(scope, copilotCutoff);
    });
  }
  close() { this.db.close(); }
}
