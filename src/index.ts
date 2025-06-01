import { serve, $ } from "bun";
import docs from "./www/docs.html";

const server = serve({
  routes: {
    "/docs": docs,
    "/ffmpeg/version": async (req) => {
      const output = await $`ffmpeg -version`.text();
      const parts = output.split("\n");
      return new Response(parts[0]);
    },
  },
  fetch(req) {
    return new Response("Hello from bunpeg!");
  },
});

console.log(`Server started on ${server.url}`);
