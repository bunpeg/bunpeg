import { rm, mkdir } from 'node:fs/promises';

export const TEMP_DIR = "./data/temp";
export const META_DIR = "./data/meta";

export async function initDir(dir: string) {
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });
}
