export type PressureInferenceModelConfig = {
  modelPath: string;
  modelName: string;
  cropSizePx: number;
  inputSizePx: number;
};

export const DEFAULT_PRESSURE_INFERENCE_MODEL_CONFIG = {
  modelPath: "/api/pressure-model",
  modelName: "final13_all_subjects_base_crop180.onnx",
  cropSizePx: 180,
  inputSizePx: 180,
} as const satisfies PressureInferenceModelConfig;

export const PRESSURE_INFERENCE_DEFAULT_INFER_HZ = 10;
