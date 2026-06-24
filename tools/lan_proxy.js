const http = require("http");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const TARGET_HOST = process.env.TARGET_HOST || "logistics-mvp";
const TARGET_PORT = Number(process.env.TARGET_PORT || 3000);

const server = http.createServer((req, res) => {
  const headers = { ...req.headers };
  delete headers.connection;
  headers["x-forwarded-for"] = req.socket.remoteAddress || "unknown";
  headers["x-forwarded-proto"] = req.socket.encrypted ? "https" : "http";

  const target = http.request({
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers
  }, (targetResponse) => {
    const responseHeaders = { ...targetResponse.headers };
    delete responseHeaders.connection;
    res.writeHead(targetResponse.statusCode || 502, responseHeaders);
    targetResponse.pipe(res);
  });

  target.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Локальное приложение временно недоступно.");
  });

  req.pipe(target);
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  console.log(`LAN gateway listens on http://${HOST}:${PORT} and forwards only to ${TARGET_HOST}:${TARGET_PORT}`);
});
