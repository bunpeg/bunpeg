import { sql, serve } from "bun";

serve({
  port: 8000,
  routes: {
    "/hello": new Response("Hello from bunpeg!"),
  },
});
