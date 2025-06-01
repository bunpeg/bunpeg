import { serve, $ } from "bun";
import fs from "node:fs";
import { readdir } from "node:fs/promises";
import { nanoid } from 'nanoid';
import { Redis } from '@upstash/redis';

import docs from "./www/docs.html";
import upload from "./www/upload.html";

const uploadDir = "./data/uploads";
const outputDir = "./data/outputs";

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

const server = serve({
  routes: {
    "/docs": docs,
    "/app": upload,
    "/ffmpeg/version": async () => {
      const output = await $`ffmpeg -version`.text();
      const parts = output.split("\n");
      return new Response(parts[0]);
    },
    "/upload": async (req) => {
      const formData = await req.formData();
      const __file = formData.get('file');
      if (!__file) throw new Error('Must upload a profile picture.');

      const fileId = nanoid(8);
      const file = __file as unknown as File;
      const parts = file.name.split('.');
      const extension = parts.pop();
      const extendedName = `${parts.join('.')}-${fileId}.${extension}`;

      await redis.set(fileId, extendedName);

      await Bun.write(`${uploadDir}/${extendedName}`, file);

      return Response.json({ fileId }, { status: 200 });
    },
    "/download/:fileId": async (req) => {
      const fileId = req.params.fileId;
      if (!fileId) throw new Error('Invalid file id');

      const fileName = await redis.get<string>(fileId);
      if (!fileName) throw new Error('Invalid file id');

      await redis.del(fileId);

      const simplifiedName = fileName.replace(`-${fileId}`, '');
      const file = Bun.file(`${uploadDir}/${fileName}`);

      return new Response(file, {
        headers: {
          'content-disposition': `attachment; filename="${simplifiedName}"`,
        },
      });
    },
    "/wipe": async () => {
      const files = await readdir(uploadDir);
      for (const file of files) {
        await Bun.file(`${uploadDir}/${file}`).delete();
      }

      return new Response(`Volume wiped! (count: ${files.length})`);
    },
  },
  fetch() {
    return new Response("Hello from bunpeg!");
  },
  error(error) {
    console.error(error);
    return new Response(`Internal Error: ${error.message}`, {
      status: 500,
      headers: {
        "Content-Type": "text/plain",
      },
    });
  },
});

console.log(`Server started on ${server.url}`);
