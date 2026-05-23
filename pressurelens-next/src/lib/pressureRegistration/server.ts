import { existsSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import path from "path";

export const REGISTRATION_LABELS = ["firm", "light", "no_press"] as const;
export type RegistrationLabel = (typeof REGISTRATION_LABELS)[number];

export const REQUIRED_REGISTRATION_SESSIONS_PER_LABEL = 5;

export type RegistrationCounts = Record<RegistrationLabel, number>;

export type RegistrationStatus = {
  userId: string;
  safeUserId: string;
  datasetRoot: string;
  counts: RegistrationCounts;
  requiredPerLabel: number;
  readyForFinetune: boolean;
  modelExists: boolean;
  modelPath: string | null;
  modelUrl: string;
};

const FINETUNE_DIR_NAME = "finetune";
const REGISTRATION_DATASETS_DIR_NAME = "registration_datasets";
const REGISTERED_MODELS_DIR_NAME = "registered_models";
const BASE_MODEL_FILENAME = "pressure_cnn_final13_all_subjects_base_crop180.onnx";

export function sanitizeUserId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function assertRegistrationLabel(value: string): asserts value is RegistrationLabel {
  if (!(REGISTRATION_LABELS as readonly string[]).includes(value)) {
    throw new Error(`Unsupported pressure label: ${value}`);
  }
}

export function getFinetuneRoot() {
  return path.join(process.cwd(), FINETUNE_DIR_NAME);
}

export function getRegistrationDatasetsRoot() {
  return path.join(getFinetuneRoot(), REGISTRATION_DATASETS_DIR_NAME);
}

export function getRegisteredModelsRoot() {
  return path.join(getFinetuneRoot(), REGISTERED_MODELS_DIR_NAME);
}

export function getBaseOnnxPath() {
  return path.join(getFinetuneRoot(), BASE_MODEL_FILENAME);
}

export function getRegistrationDatasetRoot(userId: string) {
  const safeUserId = sanitizeRequiredUserId(userId);
  return path.join(getRegistrationDatasetsRoot(), `pressure-dataset-${safeUserId}`);
}

export function getRegistrationPatchesRoot(userId: string) {
  return path.join(getRegistrationDatasetRoot(userId), "patches");
}

export function getRegistrationSessionsRoot(userId: string) {
  return path.join(getRegistrationDatasetRoot(userId), "sessions");
}

export function getRegisteredRunName(userId: string) {
  return `registered_${sanitizeRequiredUserId(userId)}_5shot_final_layer_crop180`;
}

export function getRegisteredOnnxPath(userId: string) {
  const runName = getRegisteredRunName(userId);
  return path.join(getRegisteredModelsRoot(), runName, `${runName}.onnx`);
}

export function getRegisteredMetricsPath(userId: string) {
  const runName = getRegisteredRunName(userId);
  return path.join(getRegisteredModelsRoot(), runName, "metrics.json");
}

export function getFinetuneScriptPath() {
  return path.join(getFinetuneRoot(), "finetune_registered_user_180.py");
}

export function sanitizeRequiredUserId(userId: string) {
  const safeUserId = sanitizeUserId(userId);
  if (!safeUserId) {
    throw new Error("userId is required.");
  }
  return safeUserId;
}

export function makeEmptyCounts(): RegistrationCounts {
  return {
    firm: 0,
    light: 0,
    no_press: 0,
  };
}

function parsePatchSession(filename: string) {
  if (!filename.endsWith(".jpg")) return null;
  const stem = filename.slice(0, -4);
  if (!stem.startsWith("pressure-collect-")) return null;

  const lastDash = stem.lastIndexOf("-");
  if (lastDash < 0) return null;
  const sessionKey = stem.slice(0, lastDash);
  const parts = sessionKey.split("-");
  if (parts.length < 5) return null;

  const rawLabel = parts.slice(2, -2).join("-").replace(/-/g, "_");
  if (!(REGISTRATION_LABELS as readonly string[]).includes(rawLabel)) {
    return null;
  }

  return {
    label: rawLabel as RegistrationLabel,
    sessionKey,
  };
}

export async function countRegistrationSessions(userId: string): Promise<RegistrationCounts> {
  const counts = makeEmptyCounts();
  const patchRoot = getRegistrationPatchesRoot(userId);
  if (!existsSync(patchRoot)) {
    return counts;
  }

  const seen = new Map<RegistrationLabel, Set<string>>();
  for (const label of REGISTRATION_LABELS) {
    seen.set(label, new Set());
  }

  const entries = await readdir(patchRoot);
  for (const entry of entries) {
    const parsed = parsePatchSession(entry);
    if (!parsed) continue;
    seen.get(parsed.label)?.add(parsed.sessionKey);
  }

  for (const label of REGISTRATION_LABELS) {
    counts[label] = seen.get(label)?.size ?? 0;
  }

  return counts;
}

export async function getRegistrationStatus(userId: string): Promise<RegistrationStatus> {
  const safeUserId = sanitizeRequiredUserId(userId);
  const counts = await countRegistrationSessions(userId);
  const modelPath = getRegisteredOnnxPath(userId);
  const modelExists = existsSync(modelPath);
  const readyForFinetune = REGISTRATION_LABELS.every(
    (label) => counts[label] >= REQUIRED_REGISTRATION_SESSIONS_PER_LABEL
  );

  return {
    userId,
    safeUserId,
    datasetRoot: getRegistrationDatasetRoot(userId),
    counts,
    requiredPerLabel: REQUIRED_REGISTRATION_SESSIONS_PER_LABEL,
    readyForFinetune,
    modelExists,
    modelPath: modelExists ? modelPath : null,
    modelUrl: `/api/pressure-model?userId=${encodeURIComponent(userId)}`,
  };
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function fileExists(filePath: string) {
  try {
    const item = await stat(filePath);
    return item.isFile();
  } catch {
    return false;
  }
}

export function pickPythonExecutable() {
  if (process.env.PRESSURE_FINETUNE_PYTHON?.trim()) {
    return process.env.PRESSURE_FINETUNE_PYTHON.trim();
  }

  const workflowPython = "C:\\Users\\wei wang\\DL\\Scripts\\python.exe";
  if (existsSync(workflowPython)) {
    return workflowPython;
  }

  return "python";
}
