import { readFile } from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import {
  fileExists,
  getBaseOnnxPath,
  getRegisteredOnnxPath,
  sanitizeUserId,
} from "@/lib/pressureRegistration/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function makeModelResponse(bytes: Buffer, modelPath: string, kind: "base" | "user") {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      "X-Pressure-Model-Kind": kind,
      "X-Pressure-Model-Name": path.basename(modelPath),
    },
  });
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId")?.trim() ?? "";
  const strict = req.nextUrl.searchParams.get("strict") === "1";

  let modelPath = getBaseOnnxPath();
  let kind: "base" | "user" = "base";

  if (userId && sanitizeUserId(userId)) {
    const userModelPath = getRegisteredOnnxPath(userId);
    if (await fileExists(userModelPath)) {
      modelPath = userModelPath;
      kind = "user";
    } else if (strict) {
      return Response.json(
        {
          error: "Registered pressure model was not found for this user.",
          userId,
          expectedPath: userModelPath,
        },
        { status: 404 }
      );
    }
  }

  if (!(await fileExists(modelPath))) {
    return Response.json(
      {
        error: "Pressure ONNX model not found.",
        path: modelPath,
      },
      { status: 404 }
    );
  }

  const bytes = await readFile(modelPath);
  return makeModelResponse(bytes, modelPath, kind);
}
