import { serve, $ } from "bun";

const server = serve({
  routes: {
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
