export type InputMode = "pencil" | "finger";

export type NearestWordLineContext = {
  /**
   * Word text list for each line, ordered top-to-bottom and left-to-right.
   * For example, linesText[i] is the w.original.text list for line i.
   */
  linesText: string[][];
  /**
   * bestLineIndex points to the "best line" within linesText.
   */
  bestLineIndex: number;
};

export type NearestWordInfo = {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  distance: number;
  /**
   * Line context during pointing: all lines' w.original.text lists and the best line index.
   * Only provided when computed via getNearestOcrWord; otherwise can be empty.
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
  rawTranscript: string;
  /**
   * When the wake word was detected (Unix ms, same clock as timestampStart/End).
   * For continuous listening mode this is typically the end of the audio chunk.
   */
  wakeWordDetectedAt?: number;
};

export type RejectedVoiceAnnotation = {
  id: string;
  timestampStart: number;
  timestampEnd: number;
  transcript: string;
  rejectedReason: "wake_word_not_detected" | "noise" | "japanese" | "other";
  wakeWord?: string;
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
  globalSessionId: string;
  pageIndex: number;
  startedAt: number;
  endedAt?: number;
  deviceInfo?: string;
  config: SessionConfig;
  pageOcr?: PageOcrInfo;
  pointerSamples: PointerSample[];
  voiceAnnotations: VoiceAnnotation[];
  rejectedVoiceAnnotations?: RejectedVoiceAnnotation[];
  selectedTopics: SelectedTopic[];
};


