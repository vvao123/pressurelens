export const PRESSURE_MODEL_USER_STORAGE_KEY = "pressurelens.pressureModelUserId";
export const PRESSURE_REGISTRATION_USER_STORAGE_KEY =
  "pressurelens.pressureRegistrationUserId";
export const PRESSURE_MODEL_UPDATED_EVENT = "pressurelens:pressure-model-updated";

export function buildPressureModelUrl(userId?: string | null, version?: number) {
  const params = new URLSearchParams();
  const trimmedUserId = userId?.trim();

  if (trimmedUserId) {
    params.set("userId", trimmedUserId);
  }

  if (version) {
    params.set("v", String(version));
  }

  const query = params.toString();
  return query ? `/api/pressure-model?${query}` : "/api/pressure-model";
}
