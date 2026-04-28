export type PressureInferenceModelConfig = {
  modelPath: string;
  modelName: string;
  cropSizePx: number;
  inputSizePx: number;
};

export const DEFAULT_PRESSURE_INFERENCE_MODEL_CONFIG = {
  modelPath: "/pressure_cnn_wei420_plus_half_wei300_crop180.onnx",
  modelName: "pressure_cnn_wei420_plus_half_wei300_crop180.onnx",
  cropSizePx: 180,
  inputSizePx: 180,
} as const satisfies PressureInferenceModelConfig;

export const PRESSURE_INFERENCE_DEFAULT_INFER_HZ = 10;
