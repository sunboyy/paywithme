// Drizzle schema entry point.
//
// This is intentionally empty for now (Phase 1 wiring only — task 1.5).
// Tables are added in later tasks:
//   - better-auth tables       → task 1.8
//   - groups / members         → task 3.1
//   - transactions / audit_log → Phase 4+
//
// drizzle-kit loads this module (see `drizzle.config.ts`) and the app's DB
// client passes it to `drizzle(pool, { schema })` for typed queries. Re-export
// table definitions from here as they are introduced.

export {};
