// signal-service.js — keeps signal-cli-rest-api alive and exposes health check
// This runs as a companion service on Railway, proxying to the signal-cli REST API

const http  = require("http");
const https = require("https");

const PORT          = process.env.PORT || 3001;
const SIGNAL_CLI_URL = (process.env.SIGNAL_CLI_URL || "https://signal-cli-rest-api-y65f.onrender.com").replace(/\/$/, "");

// Simple health/proxy server so Railway keeps the service alive
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", signal_cli_url: SIGNAL_CLI_URL }));
    return;
  }

  // Proxy all other requests to signal-cli-rest-api
  const target = new URL(req.url, SIGNAL_CLI_URL);
  const lib    = target.protocol === "https:" ? https : http;

  const proxy = lib.request(
    { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxy.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  });

  req.pipe(proxy);
});

server.listen(PORT, () => {
  console.log(`✅ Signal service running on port ${PORT}`);
  console.log(`📡 Proxying to: ${SIGNAL_CLI_URL}`);
});

// Keep-alive ping to prevent signal-cli Render instance from sleeping
const PING_INTERVAL = 8 * 60 * 1000; // every 8 minutes
setInterval(() => {
  const lib = SIGNAL_CLI_URL.startsWith("https") ? https : http;
  lib.get(`${SIGNAL_CLI_URL}/v1/about`, (res) => {
    console.log(`📡 Signal CLI ping: ${res.statusCode}`);
  }).on("error", (e) => {
    console.warn(`⚠️  Signal CLI ping failed: ${e.message}`);
  });
}, PING_INTERVAL);
