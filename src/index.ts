import { serve } from "bun";

const server = serve({
  routes: {
    "/hello": new Response("Hello from bunpeg!"),
  },
  fetch(req) {
    return new Response("Hello from bunpeg!");
  },
});

console.log(`Server started on ${server.url}`);
