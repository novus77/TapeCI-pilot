import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sendEmail, sendSlack } from "../../../apps/api/src/notifications.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("notification transports", () => {
  it("posts a Slack webhook payload", async () => {
    let body = "";
    const server = createHttpServer((request, response) => {
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        response.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    await sendSlack(`http://127.0.0.1:${address.port}/hook`, "deployment is live");
    expect(JSON.parse(body)).toEqual({ text: "deployment is live" });
  });

  it("delivers email over SMTP", async () => {
    let data = "";
    const server = createNetServer((socket) => {
      let buffer = "";
      let inData = false;
      socket.write("220 test-smtp ready\r\n");
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const index = buffer.indexOf("\r\n");
          if (index < 0) return;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 queued\r\n");
            } else {
              data += `${line}\n`;
            }
            continue;
          }
          if (line.startsWith("EHLO") || line.startsWith("HELO")) socket.write("250-test-smtp\r\n250 OK\r\n");
          else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 OK\r\n");
          else if (line === "DATA") {
            inData = true;
            socket.write("354 end with .\r\n");
          } else if (line === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
          } else socket.write("250 OK\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    await sendEmail(
      { smtpUrl: `smtp://127.0.0.1:${address.port}`, smtpFrom: "tapeci@example.com" } as ApiEnv,
      "ops@example.com",
      "TapeCI LIVE",
      "deployment is live",
    );
    expect(data).toContain("Subject: TapeCI LIVE");
    expect(data).toContain("deployment is live");
  });
});
