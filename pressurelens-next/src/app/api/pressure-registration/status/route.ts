import { NextRequest } from "next/server";
import { getRegistrationStatus } from "@/lib/pressureRegistration/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId")?.trim() ?? "";

  if (!userId) {
    return Response.json({ error: "userId is required." }, { status: 400 });
  }

  try {
    const status = await getRegistrationStatus(userId);
    return Response.json(status, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 400 }
    );
  }
}
