import { listDeployments } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events for the console. The route polls the API server-side and
 * pushes a compact deployment snapshot; the browser never calls the API
 * cross-origin and the session cookie stays on the web origin.
 */
export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = async (): Promise<void> => {
        if (closed) return;
        try {
          const deployments = await listDeployments({ limit: 50 });
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ deployments: deployments.map((deployment) => ({ id: deployment.id, state: deployment.state })) })}\n\n`),
          );
        } catch {
          controller.enqueue(encoder.encode(": poll failed\n\n"));
        }
      };
      void send();
      const timer = setInterval(() => void send(), 3_000);
      const close = (): void => {
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", close);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
