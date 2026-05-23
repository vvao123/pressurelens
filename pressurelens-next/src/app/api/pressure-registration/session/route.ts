import { mkdir, writeFile } from "fs/promises";
import path from "path";
import {
  assertRegistrationLabel,
  getRegistrationDatasetRoot,
  getRegistrationPatchesRoot,
  getRegistrationSessionsRoot,
  getRegistrationStatus,
  sanitizeRequiredUserId,
  type RegistrationLabel,
} from "@/lib/pressureRegistration/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SaveSessionBody = {
  userId?: string;
  label?: string;
  frames?: string[];
  startedAt?: number;
  endedAt?: number;
  metadata?: Record<string, unknown>;
};

function parseJpegDataUrl(value: string) {
  const match = value.match(/^data:image\/jpeg;base64,(.+)$/);
  if (!match) {
    throw new Error("Each frame must be a JPEG data URL.");
  }
  return Buffer.from(match[1], "base64");
}

function makeSessionId(label: RegistrationLabel) {
  const t = Date.now();
  const r = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, "0");
  return `pressure-collect-${label}-${t}-${r}`;
}

export async function POST(req: Request) {
  let body: SaveSessionBody;

  try {
    body = (await req.json()) as SaveSessionBody;
  } catch (error) {
    return Response.json(
      {
        error: "Invalid JSON body.",
        detail: String(error),
      },
      { status: 400 }
    );
  }

  const userId = body.userId?.trim() ?? "";
  const label = body.label ?? "";
  const frames = Array.isArray(body.frames) ? body.frames : [];

  try {
    sanitizeRequiredUserId(userId);
    assertRegistrationLabel(label);

    if (frames.length === 0) {
      throw new Error("At least one captured frame is required.");
    }

    const datasetRoot = getRegistrationDatasetRoot(userId);
    const patchesRoot = getRegistrationPatchesRoot(userId);
    const sessionsRoot = getRegistrationSessionsRoot(userId);
    await mkdir(patchesRoot, { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });

    const sessionId = makeSessionId(label);
    const patchPaths: string[] = [];

    await Promise.all(
      frames.map(async (frame, index) => {
        const frameId = String(index + 1).padStart(6, "0");
        const filename = `${sessionId}-${frameId}.jpg`;
        const filePath = path.join(patchesRoot, filename);
        await writeFile(filePath, parseJpegDataUrl(frame));
        patchPaths.push(`patches/${filename}`);
      })
    );

    const summary = {
      user_id: userId,
      session_id: sessionId,
      label,
      started_at: body.startedAt ?? null,
      ended_at: body.endedAt ?? Date.now(),
      frame_count: frames.length,
      patch_paths: patchPaths.sort(),
      metadata: body.metadata ?? {},
    };

    await writeFile(
      path.join(sessionsRoot, `${sessionId}.json`),
      JSON.stringify(summary, null, 2),
      "utf8"
    );

    await writeFile(
      path.join(datasetRoot, "registration_manifest.json"),
      JSON.stringify(
        {
          user_id: userId,
          updated_at: Date.now(),
          schema: "pressure-registration-5shot-crop180",
          patches_dir: "patches",
          sessions_dir: "sessions",
        },
        null,
        2
      ),
      "utf8"
    );

    const status = await getRegistrationStatus(userId);
    return Response.json({
      sessionId,
      savedFrames: frames.length,
      status,
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
