import { $ } from "bun";
import { Database } from 'bun:sqlite';

export async function initDb() {
  console.log('-------------- DB init --------------');
  await $`bun run db:push`;
  setWalMode();
  console.log('-------------- DB init end --------------');
}

function setWalMode() {
  using db = connectDb();
  db.exec("PRAGMA journal_mode = WAL;");
}

export function connectDb() {
  return new Database("./db/db.sqlite", { create: true, strict: true });
}
