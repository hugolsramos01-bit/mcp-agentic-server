/**
 * Minimal proxy that sits in front of the real server and logs the full
 * body of POST /token before forwarding, so we can see what ChatGPT sends.
 *
 * Usage:
 *   node scripts/debug-token.mjs
 *
 * Then point the ngrok tunnel to port 8000 instead of 7676 temporarily:
 *   ngrok http --domain=america-descriptive-lacy.ngrok-free.dev 127.0.0.1:8000
 */

import http from "node:http";

const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = 7676;
const PROXY_PORT = 8000;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const bodyStr = body.toString("utf8");

    if (req.url === "/token" && req.method === "POST") {
      console.log("\n===== POST /token =====");
      console.log("Headers:", JSON.stringify(req.headers, null, 2));
      console.log("Body:", bodyStr);
      console.log("=======================\n");
    }

    // Forward to real server
    const options = {
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      const resChunks = [];
      proxyRes.on("data", (c) => resChunks.push(c));
      proxyRes.on("end", () => {
        const resBody = Buffer.concat(resChunks).toString("utf8");
        if (req.url === "/token") {
          console.log(`<= /token response ${proxyRes.statusCode}:`, resBody);
        }
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(resBody);
      });
    });

    proxyReq.on("error", (e) => {
      console.error("Proxy error:", e.message);
      res.writeHead(502);
      res.end("Proxy error");
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`Debug proxy running on http://127.0.0.1:${PROXY_PORT}`);
  console.log(`Forwarding to http://${TARGET_HOST}:${TARGET_PORT}`);
  console.log("\nNow restart ngrok pointing to port 8000:");
  console.log(`  ngrok http --domain=america-descriptive-lacy.ngrok-free.dev 127.0.0.1:${PROXY_PORT}`);
});
