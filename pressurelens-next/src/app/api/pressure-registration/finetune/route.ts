import { spawn } from "child_process";
import {
  getFinetuneScriptPath,
  getRegisteredMetricsPath,
  getRegisteredModelsRoot,
  getRegistrationDatasetRoot,
  getRegistrationStatus,
  pickPythonExecutable,
  readJsonFile,
  REGISTRATION_LABELS,
  REQUIRED_REGISTRATION_SESSIONS_PER_LABEL,
  sanitizeRequiredUserId,
} from "@/lib/pressureRegistration/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FinetuneBody = {
  userId?: string;
  inputRoot?: string;
};

function runPython(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const python = pickPythonExecutable();
    const child = spawn(python, args, {
      cwd: process.cwd(),
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function POST(req: Request) {
  let body: FinetuneBody;

  try {
    body = (await req.json()) as FinetuneBody;
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

  try {
    sanitizeRequiredUserId(userId);
    const status = await getRegistrationStatus(userId);
    const missing = REGISTRATION_LABELS.filter(
      (label) => status.counts[label] < REQUIRED_REGISTRATION_SESSIONS_PER_LABEL
    );

    if (missing.length > 0) {
      return Response.json(
        {
          error: "Registration dataset is incomplete.",
          counts: status.counts,
          requiredPerLabel: REQUIRED_REGISTRATION_SESSIONS_PER_LABEL,
        },
        { status: 400 }
      );
    }

    const inputRoot = body.inputRoot?.trim() || getRegistrationDatasetRoot(userId);
    const args = [
      getFinetuneScriptPath(),
      "--input-root",
      inputRoot,
      "--user-id",
      userId,
      "--output-root",
      getRegisteredModelsRoot(),
    ];

    const result = await runPython(args);
    if (result.code !== 0) {
      return Response.json(
        {
          error: "Fine-tune script failed.",
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        { status: 500 }
      );
    }

    const nextStatus = await getRegistrationStatus(userId);
    const metrics = await readJsonFile<Record<string, unknown>>(getRegisteredMetricsPath(userId));

    return Response.json({
      status: nextStatus,
      metrics,
      stdout: result.stdout,
      stderr: result.stderr,
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
