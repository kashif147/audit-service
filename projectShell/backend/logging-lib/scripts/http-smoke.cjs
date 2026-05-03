#!/usr/bin/env node
"use strict";

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");

const lib = require("..");
const { correlationIdMiddleware, createLogger, createSystemLogsRouter } = lib;

const tmp = path.join(__dirname, "..", ".tmp-http-smoke");
fs.mkdirSync(tmp, { recursive: true });
process.chdir(tmp);

const blog = createLogger("http-smoke");
const app = express();
app.use(express.json());
app.use(correlationIdMiddleware);
app.use("/api", createSystemLogsRouter(blog));
app.get("/ping", (req, res) => res.json({ correlationId: req.correlationId }));

function httpReq(method, pPath, headers, body, cb) {
  const data = body ? JSON.stringify(body) : null;
  const h = { ...headers };
  if (data) {
    h["Content-Type"] = "application/json";
    h["Content-Length"] = String(Buffer.byteLength(data));
  }
  const port = process.env.__SMOKE_PORT;
  const r = http.request(
    {
      hostname: "127.0.0.1",
      port,
      method,
      path: pPath,
      headers: h,
    },
    (res) => {
      let b = "";
      res.on("data", (c) => {
        b += c;
      });
      res.on("end", () => cb(res.statusCode, res.headers, b));
    }
  );
  if (data) r.write(data);
  r.end();
}

const srv = app.listen(0, () => {
  process.env.__SMOKE_PORT = String(srv.address().port);
  httpReq("GET", "/ping", { "x-correlation-id": "fixed-cid" }, null, (code, h, b) => {
    const j = JSON.parse(b);
    if (j.correlationId !== "fixed-cid") {
      throw new Error("cid mismatch");
    }
    if (String(h["x-correlation-id"]) !== "fixed-cid") {
      throw new Error("response header missing");
    }
    httpReq("POST", "/api/system-logs", {}, { foo: 1 }, (c400) => {
      if (c400 !== 400) throw new Error("expect 400 for invalid body, got " + c400);
      httpReq(
        "POST",
        "/api/system-logs",
        {},
        {
          eventType: "N8nTest",
          workflowName: "WF",
          executionId: "ex1",
        },
        (c204) => {
          if (c204 !== 204) throw new Error("expect 204, got " + c204);
          httpReq(
            "POST",
            "/api/system-logs",
            {},
            { correlationId: "only-correlation" },
            (c204b) => {
              if (c204b !== 204) throw new Error("expect 204 corr-only, got " + c204b);
              console.log("HTTP_CORRELATION_AND_SYSTEM_LOGS_OK");
              srv.close(() => {
                fs.rmSync(tmp, { recursive: true, force: true });
              });
            }
          );
        }
      );
    });
  });
});
