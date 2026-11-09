/**
 * Create a GitHub App through the official App Manifest flow.
 *
 *   corepack pnpm github:create-app
 *
 * Opens GitHub in the browser; after the user clicks "Create GitHub App", GitHub
 * redirects to a local callback, we exchange the one-time code for the App's
 * credentials, and write them to `.tapeci/github-app.env` (mode 0600, gitignored).
 *
 * Secrets are never printed and never leave the machine except to GitHub itself.
 */
import { createServer } from "node:http";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

interface Options {
  readonly name: string;
  readonly org: string | null;
  readonly port: number;
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly webhookUrl: string;
  readonly withWebhook: boolean;
  readonly printOnly: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const apiUrl = (value("--api-url") ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  return {
    name: value("--name") ?? `tapeci-local-${randomBytes(3).toString("hex")}`,
    org: value("--org") ?? null,
    port: Number(value("--port") ?? "8790"),
    apiUrl,
    webUrl: (value("--web-url") ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
    webhookUrl: value("--webhook-url") ?? `${apiUrl}/v1/github/webhook`,
    withWebhook: !argv.includes("--no-webhook"),
    printOnly: argv.includes("--print-manifest"),
  };
}

function manifest(options: Options, redirectUrl: string): Record<string, unknown> {
  return {
    name: options.name,
    url: options.webUrl,
    // GitHub's manifest validator requires a non-empty hook URL even if the App
    // will not receive webhooks yet. Use an inert placeholder and change it in
    // App settings once a public smee/ngrok/production URL exists.
    hook_attributes: {
      url: options.withWebhook ? options.webhookUrl : "https://example.com/tapeci-webhook",
      active: true,
    },
    redirect_url: redirectUrl,
    callback_urls: [`${options.apiUrl}/v1/auth/github/callback`],
    setup_url: `${options.apiUrl}/v1/github/setup`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      metadata: "read",
      contents: "read",
    },
    // `installation` is a lifecycle event delivered to the App automatically and
    // is rejected in manifest default_events; push is the only opt-in event here.
    default_events: ["push"],
  };
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;margin:40px;max-width:720px;line-height:1.5}
code{background:#f5f5fa;padding:2px 5px;border-radius:4px}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve) => {
    execFile(command, args, () => resolve());
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const redirectUrl = `http://127.0.0.1:${options.port}/callback`;
  const manifestJson = JSON.stringify(manifest(options, redirectUrl));
  const state = randomBytes(16).toString("hex");
  const action = options.org === null
    ? "https://github.com/settings/apps/new"
    : `https://github.com/organizations/${encodeURIComponent(options.org)}/settings/apps/new`;

  if (options.printOnly) {
    console.log(JSON.stringify({ action, state, manifest: JSON.parse(manifestJson) }, null, 2));
    return;
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", redirectUrl);
    if (url.pathname === "/" ) {
      const html = page(
        "Create TapeCI GitHub App",
        `<form id="f" method="post" action="${action}?state=${state}">
<input type="hidden" name="manifest" value='${manifestJson.replace(/'/g, "&#39;")}'>
<p>Continue to GitHub and click <strong>Create GitHub App</strong>.</p>
<button type="submit">Continue to GitHub</button></form>
<script>document.getElementById("f").submit()</script>`,
      );
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    if (code === null || returnedState !== state) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(page("Creation failed", "<p>State mismatch or missing code. Close this tab and retry.</p>"));
      return;
    }
    void (async () => {
      try {
        const conversion = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "tapeci-create-app",
            "x-github-api-version": "2022-11-28",
          },
        });
        if (!conversion.ok) {
          throw new Error(`GitHub manifest conversion failed: HTTP ${conversion.status}`);
        }
        const app = (await conversion.json()) as Record<string, unknown>;
        const required = ["id", "slug", "pem", "webhook_secret", "client_id", "client_secret"] as const;
        for (const field of required) {
          if (typeof app[field] !== "string" && typeof app[field] !== "number") {
            throw new Error(`manifest response is missing ${field}`);
          }
        }
        const dir = join(process.cwd(), ".tapeci");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const envPath = join(dir, "github-app.env");
        // Dotenv format: the PEM contains real newlines; never source this file
        // from a shell. Use `pnpm github:load-env` or the provided Node loader.
        const lines = [
          "# Generated by `pnpm github:create-app`; mode 0600. Dotenv format, do not source.",
          `GITHUB_APP_ID=${String(app["id"])}`,
          `GITHUB_APP_SLUG=${String(app["slug"])}`,
          `GITHUB_APP_PRIVATE_KEY=${JSON.stringify(String(app["pem"]))}`,
          `GITHUB_WEBHOOK_SECRET=${JSON.stringify(String(app["webhook_secret"]))}`,
          `GITHUB_OAUTH_CLIENT_ID=${JSON.stringify(String(app["client_id"]))}`,
          `GITHUB_OAUTH_CLIENT_SECRET=${JSON.stringify(String(app["client_secret"]))}`,
          `TAPECI_PUBLIC_API_URL=${options.apiUrl}`,
          `TAPECI_WEB_URL=${options.webUrl}`,
          "TAPECI_DEV_AUTH=0",
          "",
        ];
        await writeFile(envPath, lines.join("\n"), { mode: 0o600 });
        await chmod(envPath, 0o600);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          page(
            "GitHub App created",
            `<p>App <strong>${String(app["name"] ?? options.name)}</strong> created.</p>
<p>Credentials written to <code>.tapeci/github-app.env</code> (mode 0600, dotenv format).</p>
<pre>corepack pnpm github:load-env -- print</pre>
<p>Webhook target: <code>${options.webhookUrl}</code>. For local development use smee/ngrok
if that URL is not publicly reachable. Install the App on your test repository, then open
<a href="${options.webUrl}/login">${options.webUrl}/login</a>.</p>`,
          ),
        );
        console.log(`GitHub App created: ${String(app["slug"])} (id ${String(app["id"])})`);
        console.log("Credentials: .tapeci/github-app.env (never printed)");
        server.close();
      } catch (error) {
        response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
        response.end(page("Creation failed", `<p>${error instanceof Error ? error.message : String(error)}</p>`));
        console.error(error instanceof Error ? error.message : String(error));
        server.close();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const startUrl = `http://127.0.0.1:${options.port}/`;
  console.log(`Waiting for GitHub App creation at ${startUrl}`);
  console.log(`App name: ${options.name}`);
  console.log(
    options.withWebhook
      ? `Webhook URL will be: ${options.webhookUrl}`
      : "Webhook uses a placeholder (https://example.com/tapeci-webhook); change it in App settings to smee/ngrok/production before relying on push deliveries.",
  );
  await openBrowser(startUrl);
  await new Promise<void>((resolve) => {
    server.on("close", resolve);
    process.once("SIGINT", () => {
      server.close();
      resolve();
    });
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
