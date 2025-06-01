import { $ } from "bun";
import { Database } from 'bun:sqlite';

export async function initDb() {
  console.log('-------------- DB init --------------');
  const file = Bun.file('../../db/db.sqlite');
  console.log('Checking db file...');
  if (!await file.exists()) {
    console.log('DB file not found, generating new db...');
    await $`bun run db:push`;
    setWalMode();
    console.log('DB generated successfully!');
    console.log('-------------- DB init end --------------');
    return;
  }
  console.log('DB found, proceeding...');
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
