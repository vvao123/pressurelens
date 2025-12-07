export type InputMode = "pencil" | "finger";

export type NearestWordLineContext = {
  /**
   * 每一行的词文本列表，按从上到下、从左到右的顺序。
   * 例如 linesText[i] 就是第 i 行的 w.original.text 列表。
   */
  linesText: string[][];
  /**
   * bestLineIndex 指向 linesText 里哪一行是“最佳行”。
   */
  bestLineIndex: number;
};

export type NearestWordInfo = {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  distance: number;
  /**
   * 指读时的行上下文信息，包括所有行的 w.original.text 列表和最佳行索引。
   * 仅在通过 getNearestOcrWord 计算时提供，其他场景可为空。
   */
  lineContext?: NearestWordLineContext;
};

export type PointerSample = {
  timestamp: number; // Unix ms
  x: number;
  y: number;
  speed: number; // px/s
  inputMode: InputMode;
  nearestWord: NearestWordInfo | null;
  pressure?: number;
  level?: "light" | "medium" | "hard";
  interestScore?: number;
};

export type PointerSampleInput = Omit<PointerSample, "speed"> & {
  speed?: number;
};

export type PageOcrInfo = {
  pageText: string;
  pageTopics: {
    text: string;
    weight: number;
    category?: string;
  }[];
};

export type VoiceAnnotation = {
  id: string;
  timestampStart: number;
  timestampEnd: number;
  transcript: string;
};

export type SelectedTopic = {
  id: string;
  timestamp: number;
  text: string;
  source: "page_topic" | "voice";
};

export type SessionConfig = {
  samplingHz: number;
};

export type SessionJson = {
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  deviceInfo?: string;
  config: SessionConfig;
  pageOcr?: PageOcrInfo;
  pointerSamples: PointerSample[];
  voiceAnnotations: VoiceAnnotation[];
  selectedTopics: SelectedTopic[];
};


