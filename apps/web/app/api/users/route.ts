import { searchUsers } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Same-origin proxy for the login picker. The browser never calls the API
 * cross-origin, so the session cookie stays on the web origin.
 */
export async function GET(request: Request): Promise<Response> {
  const term = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const users = await searchUsers(term);
    return Response.json({ users });
  } catch {
    // A failed lookup is not an error the user must see: the field still accepts a
    // typed login, so return an empty list rather than a 500.
    return Response.json({ users: [] });
  }
}
