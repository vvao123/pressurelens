"use client";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { createWorker, Worker } from "tesseract.js";
import { recognizeWordsFromCanvas, WordBBox } from "../lib/ocr/tesseract";
import * as THREE from "three";
import { sessionLogger } from "../lib/logging/sessionLogger";
import { getNearestOcrWord } from "../lib/logging/nearestWord";
import type { PointerSampleInput, VoiceAnnotation, NearestWordInfo } from "../lib/logging/types";
import PressureInferenceOverlay from "../components/PressureInferenceOverlay";
import VoiceTopicRecorder from "../components/VoiceTopicRecorder";
import { useTopicRanking } from "../lib/topicRanking/useTopicRanking";
import {
  PRESSURE_MODEL_UPDATED_EVENT,
  PRESSURE_MODEL_USER_STORAGE_KEY,
} from "../lib/inference/pressureModelRegistration";
import {
  PRESSURE_CAMERA_CONSTRAINTS,
  normalizePressureFingertipUv,
} from "../lib/inference/pressurePatch";
import type { PressurePredictionClass } from "../lib/inference/usePressureInference";

type Level = "light" | "medium" | "hard";
type PressureLlmContextMode = "auto" | "page" | "ondemand";

const normalizeTopicKey = (text: string) => text.trim().toLowerCase();

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const threeCanvasRef = useRef<HTMLCanvasElement>(null); // Three.js render canvas
  const threeRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const threeSceneRef = useRef<THREE.Scene | null>(null);
  const threeCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const threePivotRef = useRef<THREE.Object3D | null>(null);
  const threeMeshRef = useRef<THREE.Mesh | null>(null);
  const threeTextureRef = useRef<THREE.VideoTexture | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const threePivotBaseYRef = useRef<number>(0); // Record baseline Y for top pivot
  const shaderUniformsRef = useRef<{ u_map: { value: THREE.Texture | null }; u_comp: { value: number } } | null>(null);
  const [warpCompensation, setWarpCompensation] = useState<number>(0.18); // Suggested range 0~0.5, 0 disables
  // Keep latest warpCompensation in ref to avoid stale closures in MediaPipe callbacks
  const warpCompensationRef = useRef<number>(warpCompensation);

  // Fingertip visual compensation strength (for MediaPipe marker alignment)
  const [fingerCompStrength, setFingerCompStrength] = useState<number>(0.057);
  const fingerCompStrengthRef = useRef<number>(fingerCompStrength);
  // Fingertip compensation shaping:
  // Empirically, in our setup MediaPipe fingertip y usually falls within ~[0.2, 0.65].
  // We want: bottom area gets *less* than linear, top area gets *more* than linear.
  // Also keep zoom influence mild so compensation doesn't blow up after pinch-zoom.
  const fingerCompYMin = 0.2;
  const fingerCompYMax = 0.65;
  const fingerCompYBalance = 0.9; // 0=linear (old), higher=top more / bottom less
  const fingerCompZoomExp = 0.6;  // 1.0 scales linearly with zoomFactor; keep <1 for stability
  // Keep finger long-press LLM toggle in ref to avoid stale closures in MediaPipe callbacks
  const isFingerLongPressLLMEnabledRef = useRef<boolean>(true);
  const offscreenRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureLockRef = useRef<boolean>(false);
  const ocrOverlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  
  // Long-press detection ref to avoid frequent setState
  const longPressRef = useRef({
    startTime: 0,
    startPosition: null as {x: number, y: number} | null,
    currentLevel: 'light' as Level,
    hasTriggered: false,
    hasScreenshot: false // Whether a screenshot has been taken
  });

  const [level, setLevel] = useState<Level>("light");
  const [worker, setWorker] = useState<Worker | null>(null);
  const [ocrReady, setOcrReady] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [answer, setAnswer] = useState<string>("");
  const [debugInfo, setDebugInfo] = useState<string>("");
  const [deviceInfo, setDeviceInfo] = useState<string>("");
  const [capturedImage, setCapturedImage] = useState<string>("");
  const [currentPressure, setCurrentPressure] = useState<number>(0);
  const [isUsingPen, setIsUsingPen] = useState<boolean>(false);
  const [currentMaxLevel, setCurrentMaxLevel] = useState<Level>("light"); // current max level
  const [isPressed, setIsPressed] = useState<boolean>(false); // Whether currently pressing
  const [isVideoFrozen, setIsVideoFrozen] = useState<boolean>(false); // Whether video is frozen
  const [drawingPath, setDrawingPath] = useState<{x: number, y: number}[]>([]); // Drawing path
  const [selectionBounds, setSelectionBounds] = useState<{left: number, top: number, width: number, height: number} | null>(null); // Selection bounds
  const [isStreaming, setIsStreaming] = useState<boolean>(false); // Enable streaming output
  const [isProcessing, setIsProcessing] = useState<boolean>(false); // Prevent duplicate processing
  const [isEnhancementEnabled, setIsEnhancementEnabled] = useState<boolean>(false); // Enable image enhancement
  const [videoScale, setVideoScale] = useState<number>(1.49); // Video scale
  const [videoTranslate, setVideoTranslate] = useState<{x: number, y: number}>({x: 0, y: 20}); // Video translation
  const [floatingResponse, setFloatingResponse] = useState<{text: string, position: {x: number, y: number}} | null>(null); // Floating response
  const [isDraggingFloat, setIsDraggingFloat] = useState<boolean>(false); // Dragging floating panel
  const [perspectiveStrength, setPerspectiveStrength] = useState<number>(80); // Perspective strength 0-100
  // Topics + voice notes panel open state
  const [isTopicsPanelOpen, setIsTopicsPanelOpen] = useState<boolean>(true);
  const [pageIndex, setPageIndex] = useState<number>(1);
  const [pressureModelUserId, setPressureModelUserId] = useState<string>("");
  const [pressureModelMessage, setPressureModelMessage] = useState<string>(
    "pressure model: final13 base"
  );
  const [isPressureLlmEnabled, setIsPressureLlmEnabled] = useState<boolean>(true);
  const [pressureLlmContextMode, setPressureLlmContextMode] =
    useState<PressureLlmContextMode>("auto");
  const [pressureInferenceClass, setPressureInferenceClass] =
    useState<PressurePredictionClass | null>(null);
  const [pressureRequestStatus, setPressureRequestStatus] =
    useState<string>("pressure request: idle");

  const [webglScreenshot, setWebglScreenshot] = useState<string>(""); // WebGL screenshot result

  // OCR selection results (main page)
  const [ocrWordsInRegion, setOcrWordsInRegion] = useState<WordBBox[] | null>(null);
  const [ocrRegion, setOcrRegion] = useState<{left: number; top: number; width: number; height: number} | null>(null);
  const [ocrScale, setOcrScale] = useState<number>(2);
  const [regionCapturedImage, setRegionCapturedImage] = useState<string>("");
  const [regionRecognizedText, setRegionRecognizedText] = useState<string>("");
  const [regionTopics, setRegionTopics] = useState<string[] | null>(null);
  const [regionTopicsLoading, setRegionTopicsLoading] = useState(false);
  const [regionTopicsError, setRegionTopicsError] = useState<string | null>(null);
  const [rankingSessionId, setRankingSessionId] = useState<string>(() => sessionLogger.getSummary().sessionId);
  const {
    rankedTopics,
    rankedTopicMap,
    debug: topicRankingDebug,
    model: topicRankingModel,
    isLoading: isTopicRankingLoading,
    error: topicRankingError,
    pushPointerSample: pushTopicRankingPointerSample,
    pushSelectedTopic,
    reset: resetTopicRanking,
  } = useTopicRanking({
    sessionId: rankingSessionId,
    pageId: `page-${pageIndex}`,
    pageTopics: regionTopics,
    enabled: true,
    topK: 5,
  });
  const pushTopicRankingPointerSampleRef = useRef(pushTopicRankingPointerSample);
  const topRankedTopics = rankedTopics.slice(0, 3);
  // Cross-page OCR carry-over: prepend previous page tail (e.g., last word) to next page text
  const ocrCarryOverRef = useRef<string>("");
  const lastOcrWordRef = useRef<string>("");
  const lastOcrRawTextRef = useRef<string>("");
  const [carryOverDebug, setCarryOverDebug] = useState<string>("");

  const extractLastWord = (text: string): string => {
    const s = (text || "").trim();
    if (!s) return "";
    // Try English-ish last token; fallback to last non-space chunk.
    const m = s.match(/([A-Za-z][A-Za-z0-9'_-]{1,})\s*$/);
    if (m?.[1]) return m[1];
    const parts = s.split(/\s+/).filter(Boolean);
    return parts[parts.length - 1] || "";
  };

  const extractTailWords = (text: string, n: number = 10): string => {
    const s = (text || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    const parts = s.split(" ").filter(Boolean);
    if (parts.length <= n) return s;
    return parts.slice(-n).join(" ");
  };

  const buildContextSnippet = (term: string, text: string, radius: number = 160): string => {
    const t = (term || "").trim();
    const s = (text || "").replace(/\s+/g, " ").trim();
    if (!t || !s) return "";
    const lowerS = s.toLowerCase();
    const lowerT = t.toLowerCase();
    const idx = lowerS.indexOf(lowerT);
    if (idx < 0) {
      // fallback: provide full OCR text as context (user requested)
      return s;
    }
    const start = Math.max(0, idx - radius);
    const end = Math.min(s.length, idx + lowerT.length + radius);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < s.length ? "..." : "";
    return `${prefix}${s.slice(start, end)}${suffix}`;
  };

  const buildNearestWordContext = (nearest: NearestWordInfo | null): string => {
    if (!nearest) return "";
    const lines = nearest.lineContext?.linesText ?? [];
    const lineIndex = nearest.lineContext?.bestLineIndex ?? -1;
    const activeLine =
      lineIndex >= 0 && lineIndex < lines.length
        ? lines[lineIndex].join(" ").trim()
        : "";
    const prevLine =
      lineIndex > 0 && lineIndex - 1 < lines.length
        ? lines[lineIndex - 1].join(" ").trim()
        : "";
    const nextLine =
      lineIndex >= 0 && lineIndex + 1 < lines.length
        ? lines[lineIndex + 1].join(" ").trim()
        : "";

    return [
      `nearest word: ${nearest.text}`,
      prevLine ? `previous line: ${prevLine}` : "",
      activeLine ? `current line: ${activeLine}` : "",
      nextLine ? `next line: ${nextLine}` : "",
    ].filter(Boolean).join("\n");
  };

  const compactForPrompt = (text: string, maxChars: number): string => {
    const normalized = (text || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars)}...`;
  };

  // Data logging toggle
  const [isLoggingEnabled, setIsLoggingEnabled] = useState<boolean>(false);
  const [lastVoiceAnnotation, setLastVoiceAnnotation] = useState<VoiceAnnotation | null>(null);

  useEffect(() => {
    sessionLogger.setPageIndex(pageIndex);
  }, [pageIndex]);

  useEffect(() => {
    pushTopicRankingPointerSampleRef.current = pushTopicRankingPointerSample;
  }, [pushTopicRankingPointerSample]);

  useEffect(() => {
    const savedUserId =
      window.localStorage.getItem(PRESSURE_MODEL_USER_STORAGE_KEY)?.trim() ?? "";
    setPressureModelUserId(savedUserId);
    setPressureModelMessage(
      savedUserId
        ? `pressure model: registered user ${savedUserId}`
        : "pressure model: final13 base"
    );
  }, []);

  const applyPressureModelUser = async () => {
    const userId = pressureModelUserId.trim();

    if (!userId) {
      window.localStorage.removeItem(PRESSURE_MODEL_USER_STORAGE_KEY);
      window.dispatchEvent(new Event(PRESSURE_MODEL_UPDATED_EVENT));
      setPressureModelMessage("pressure model: final13 base");
      return;
    }

    try {
      setPressureModelMessage(`checking registered model for ${userId}...`);
      const res = await fetch(
        `/api/pressure-registration/status?userId=${encodeURIComponent(userId)}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? "failed to check pressure model");
      }
      if (!data?.modelExists) {
        setPressureModelMessage(`no registered ONNX found for ${userId}`);
        return;
      }

      window.localStorage.setItem(PRESSURE_MODEL_USER_STORAGE_KEY, userId);
      window.dispatchEvent(new Event(PRESSURE_MODEL_UPDATED_EVENT));
      setPressureModelMessage(`pressure model: registered user ${userId}`);
    } catch (error) {
      setPressureModelMessage(
        `model check failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const resetSessionForNewPage = () => {
    // Store carry-over tail for next page BEFORE resetting
    const tail = lastOcrWordRef.current || extractTailWords(lastOcrRawTextRef.current, 10);
    ocrCarryOverRef.current = tail;
    if (tail) {
      console.log("[CarryOver] set for next page:", { pageIndex, tail });
      setCarryOverDebug(`carry-over(next page)="${tail}"`);
    } else {
      console.log("[CarryOver] set for next page: <empty>", { pageIndex });
      setCarryOverDebug(`carry-over(next page)=<empty>`);
    }
    const s = sessionLogger.getSummary();
    const hasLogs =
      s.pointerSamples > 0 ||
      s.voiceAnnotations > 0 ||
      s.selectedTopics > 0 ||
      s.hasPageOcr;
    if (hasLogs) {
      sessionLogger.exportJson(deviceInfo);
      setDownloadToast("Saved current page package and ready for the next page");
      setTimeout(() => setDownloadToast(null), 1500);
      setPageIndex((prev) => prev + 1);
    }
    sessionLogger.reset();
    resetTopicRanking();
    
  };

  // Main page: OCR selection handling
  const runRegionOCR = async () => {
    // Run OCR on the full visible container (no blue selection required)
    const container = document.querySelector('.video-container') as HTMLElement | null;
    if (!container) return;
    const region = {
      left: 0,
      top: 0,
      width: container.clientWidth,
      height: container.clientHeight,
    };
    const isIPad = /iPad|iPhone|iPod/.test(navigator.userAgent) || ((/Macintosh/.test(navigator.userAgent)) && (navigator.maxTouchPoints > 1));
    const scale = isIPad ? 1.5 : 2;
    const crop = captureWYSIWYGRegionHiRes(region, scale) || captureWYSIWYGRegion(region);
    if (!crop) return;
    try {
      setRegionCapturedImage(crop.toDataURL("image/png"));
    } catch {}
    setRegionTopics(null);
    setRegionTopicsError(null);

    const words = await recognizeWordsFromCanvas(crop, "eng");
    setOcrWordsInRegion(words);
    setOcrRegion(region);
    setOcrScale(scale);
    const fullText = words.map((w) => w.text).join(" ").trim();
    try {
      // Remember raw text and last word for cross-page carry-over
      lastOcrRawTextRef.current = fullText;
      // Use tail words (default 10) for cross-page carry-over
      lastOcrWordRef.current = extractTailWords(fullText, 10) || extractLastWord(fullText);
      const carry = (ocrCarryOverRef.current || "").trim();
      const combinedText = carry ? `${carry} ${fullText}`.trim() : fullText;
      setRegionRecognizedText(combinedText);
      if (carry) {
        console.log("[CarryOver] OCR combined:", {
          pageIndex,
          carry,
          rawHead: fullText.slice(0, 80),
          combinedHead: combinedText.slice(0, 80),
        });
        setCarryOverDebug(`carry-over(prev page)="${carry}"`);
      } else {
        setCarryOverDebug(`carry-over(prev page)=<empty>`);
      }
    } catch {}

    // Save full-page OCR text into sessionLogger and call LLM for topics
    const carry = (ocrCarryOverRef.current || "").trim();
    const combinedText = carry ? `${carry} ${fullText}`.trim() : fullText;
    if (!combinedText) {
      setRegionTopics([]);
      sessionLogger.setPageOcr({ pageText: "", pageTopics: [] });
      return;
    }

    try {
      setRegionTopicsLoading(true);
      const res = await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: combinedText, maxTopics: 80 }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("[Region OCR] /api/topics error:", res.status, errText);
        setRegionTopicsError(`Topics API error: ${res.status}`);
        setRegionTopics([]);
        sessionLogger.setPageOcr({ pageText: fullText, pageTopics: [] });
        return;
      }

      const data = await res.json();
      const listRaw = Array.isArray(data?.topics) ? data.topics : [];
      const list = listRaw
        .map((t: any) => (typeof t === "string" ? t.trim() : String(t ?? "").trim()))
        .filter(Boolean);
      setRegionTopics(list);
      sessionLogger.setPageOcr({
        pageText: combinedText,
        pageTextRaw: fullText,
        carryOverFromPrev: carry || undefined,
        pageTopics: list,
      });
      console.log("[Region OCR] topics for recommendation:", list);
    } catch (e) {
      console.error("[Region OCR] failed to call /api/topics:", e);
      setRegionTopicsError("Failed to generate topics");
      setRegionTopics([]);
      sessionLogger.setPageOcr({ pageText: fullText, pageTopics: [] });
    } finally {
      setRegionTopicsLoading(false);
    }
  };

  const clearRegionOCR = () => {
    setOcrWordsInRegion(null);
    setOcrRegion(null);
    setRegionCapturedImage("");
    setRegionRecognizedText("");
    setRegionTopics(null);
    setRegionTopicsError(null);
    resetTopicRanking();
  };

  // Draw OCR overlay word boxes onto ocrOverlayCanvas
  useEffect(() => {
    const c = ocrOverlayCanvasRef.current;
    const container = document.querySelector(".video-container") as HTMLElement | null;
    if (!c || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (c.width !== cw * dpr) c.width = cw * dpr;
    if (c.height !== ch * dpr) c.height = ch * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    if (!ocrWordsInRegion || !ocrRegion) return;

    const scaleBack = (val: number) => val / (dpr * (ocrScale || 1));
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.fillStyle = "rgba(255,255,0,0.18)";
    for (const w of ocrWordsInRegion) {
      const x = ocrRegion.left + scaleBack(w.bbox.x);
      const y = ocrRegion.top + scaleBack(w.bbox.y);
      const W = scaleBack(w.bbox.w);
      const H = scaleBack(w.bbox.h);
      ctx.fillRect(x, y, W, H);
      ctx.strokeRect(x, y, W, H);
    }
  }, [ocrWordsInRegion, ocrRegion, ocrScale, videoScale, videoTranslate]);

  // Hand detection state
  const [handResults, setHandResults] = useState<any>(null); // MediaPipe detection results
  const [fingerTipPosition, setFingerTipPosition] = useState<{x: number, y: number} | null>(null); // Fingertip position
  const [fingerTipUv, setFingerTipUv] = useState<{u: number, v: number} | null>(null); // Fingertip uv on the raw video
  const [isHandDetectionEnabled, setIsHandDetectionEnabled] = useState<boolean>(true); // Enable hand detection
  const [handDetectionMode, setHandDetectionMode] = useState<'pencil' | 'finger'>('finger'); // Input mode
  const [handsInstance, setHandsInstance] = useState<any>(null); // MediaPipe Hands instance
  
  // User interest detection state
  const [isInterestDetectionEnabled, setIsInterestDetectionEnabled] = useState<boolean>(true); // Enable interest detection
  const [movementTrail, setMovementTrail] = useState<Array<{x: number, y: number, timestamp: number, speed: number}>>([]); // Movement trail

  // Sync warpCompensation to ref for MediaPipe callbacks and Three.js projection
  useEffect(() => {
    warpCompensationRef.current = warpCompensation;
  }, [warpCompensation]);

  useEffect(() => {
    fingerCompStrengthRef.current = fingerCompStrength;
  }, [fingerCompStrength]);
  const [interestHeatmap, setInterestHeatmap] = useState<Map<string, number>>(new Map()); // Interest heatmap
  const [currentInterestScore, setCurrentInterestScore] = useState<number>(0); // Current interest score
  const [detectedKeywords, setDetectedKeywords] = useState<string[]>([]); // Detected keywords
  const [interestAnalysis, setInterestAnalysis] = useState<{
    totalInterestScore: number;
    averageSpeed: number;
    focusAreas: Array<{x: number, y: number, radius: number, score: number}>;
    topKeywords: Array<{keyword: string, score: number}>;
  } | null>(null); // Interest analysis result

  // Debug: nearest OCR word to the fingertip
  const [debugNearestWord, setDebugNearestWord] = useState<NearestWordInfo | null>(null);

  // ===== Sampling refs: ensure timers always read latest values without frequent effect rebuilds =====
  const fingerTipPositionRef = useRef<{x: number; y: number} | null>(null);
  const ocrWordsInRegionRef = useRef<WordBBox[] | null>(null);
  const ocrRegionRef = useRef<{left: number; top: number; width: number; height: number} | null>(null);
  const ocrScaleRef = useRef<number | null>(null);
  const handDetectionModeRef = useRef<'pencil' | 'finger'>('pencil');
  const currentPressureRef = useRef<number>(0);
  const levelRef = useRef<Level>('light');
  const currentInterestScoreRef = useRef<number>(0);
  const nearestWordRef = useRef<NearestWordInfo | null>(null);
  const isPressureLlmEnabledRef = useRef<boolean>(isPressureLlmEnabled);
  const pressureRequestLockRef = useRef<boolean>(false);
  const pressureInteractionActiveRef = useRef<boolean>(false);
  const pressureTriggeredClassRef = useRef<Exclude<
    PressurePredictionClass,
    "NoPress"
  > | null>(null);
  const pressureLastTriggerAtRef = useRef<number>(0);
  const pressureCandidateRef = useRef<{
    prediction: PressurePredictionClass;
    since: number;
  } | null>(null);

  useEffect(() => {
    fingerTipPositionRef.current = fingerTipPosition;
  }, [fingerTipPosition]);

  useEffect(() => {
    ocrWordsInRegionRef.current = ocrWordsInRegion;
  }, [ocrWordsInRegion]);

  useEffect(() => {
    ocrRegionRef.current = ocrRegion;
  }, [ocrRegion]);

  useEffect(() => {
    ocrScaleRef.current = ocrScale;
  }, [ocrScale]);

  useEffect(() => {
    handDetectionModeRef.current = handDetectionMode;
  }, [handDetectionMode]);

  useEffect(() => {
    currentPressureRef.current = currentPressure;
  }, [currentPressure]);

  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  useEffect(() => {
    currentInterestScoreRef.current = currentInterestScore;
  }, [currentInterestScore]);

  useEffect(() => {
    isPressureLlmEnabledRef.current = isPressureLlmEnabled;
  }, [isPressureLlmEnabled]);
  
  // Pointing data sampling (~10Hz): record fingertip position + nearest OCR word
  useEffect(() => {
    const intervalMs = 100; // 10Hz
    let timer: number | undefined;

    const tick = () => {
      const pointer = fingerTipPositionRef.current;
      const words = ocrWordsInRegionRef.current;
      const region = ocrRegionRef.current;
      const scale = ocrScaleRef.current;
      const mode = handDetectionModeRef.current;
      const pressure = currentPressureRef.current;
      const lvl = levelRef.current;
      const interest = currentInterestScoreRef.current;

      if (pointer) {
        let nearest: NearestWordInfo | null = null;

        if (words && words.length > 0 && region && scale) {
          const t0 = (typeof performance !== "undefined" && performance.now)
            ? performance.now()
            : Date.now();

          nearest = getNearestOcrWord(
            words,
            region,
            scale,
            pointer,
            { maxDistancePx: Infinity }
          );

          const t1 = (typeof performance !== "undefined" && performance.now)
            ? performance.now()
            : Date.now();
          const dt = t1 - t0;
          if (dt > 0.1) {
            console.log(
              "[NearestWord][perf] cost:",
              dt.toFixed(3),
              "ms",
              "| words:",
              words.length
            );
          }
          setDebugInfo(dt.toFixed(3));
        } else {
          setDebugInfo(
            "pointer:true " +
            "words:" + (words ? "true" : "false") +
            " len>0:" + (words && words.length > 0 ? "true" : "false") +
            " region:" + (region ? "true" : "false") +
            " scale:" + (scale ? "true" : "false")
          );
        }

        // Always record fingertip samples at 10Hz; nearestWord may be null
        const sample: PointerSampleInput = {
          timestamp: Date.now(),
          x: pointer.x,
          y: pointer.y,
          inputMode: mode,
          nearestWord: nearest,
          pressure,
          level: lvl,
          interestScore: interest,
          speed: undefined,
        };
        pushTopicRankingPointerSampleRef.current(sample);
        if (isLoggingEnabled) {
          sessionLogger.addPointerSample(sample);
        }
        nearestWordRef.current = nearest;
        setDebugNearestWord(nearest);
      } else {
        // No fingertip detected; skip logging and keep nearest word semantic-free.
        nearestWordRef.current = null;
        setDebugNearestWord(null);
      }

      timer = window.setTimeout(tick, intervalMs);
    };

    timer = window.setTimeout(tick, intervalMs);
    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [isLoggingEnabled]);
  
  // Long-press detection state (UI-only fields)
  const [longPressState, setLongPressState] = useState<{
    isActive: boolean;
    currentDuration: number;
    currentLevel: Level;
    shouldTriggerOnMove: Level | false; // Indicates which level should trigger; false = no trigger
    startPosition: {x: number, y: number} | null;
  }>({
    isActive: false,
    currentDuration: 0,
    currentLevel: 'light',
    shouldTriggerOnMove: false,
    startPosition: null
  });
  
  // Hand detection config
  const [handDetectionConfig, setHandDetectionConfig] = useState({
    minDetectionConfidence: 0.8,
    minTrackingConfidence: 0.8,
    modelComplexity: 1
  });

  // Long-press config
  const longPressConfig = {
    positionTolerance: 15, // Position tolerance (px)
    lightThreshold: 1800,   // light threshold (ms)
    mediumThreshold: 3000, // medium threshold (ms)
    hardThreshold: 5500,   // hard threshold (ms)
    autoTriggerDelay: 1800  // Auto-trigger delay (ms)
  };

  // Finger mode: toggle long-press LLM
  const [isFingerLongPressLLMEnabled, setIsFingerLongPressLLMEnabled] = useState<boolean>(false);
  // Sync finger long-press LLM toggle to ref for MediaPipe callbacks
  useEffect(() => {
    isFingerLongPressLLMEnabledRef.current = isFingerLongPressLLMEnabled;
  }, [isFingerLongPressLLMEnabled]);

  // Training topic selection (for toast display)
  const [lastSelectedTopic, setLastSelectedTopic] = useState<string | null>(null);
  const topicMeaningCacheRef = useRef<Map<string, string>>(new Map());
  const topicMeaningInFlightRef = useRef<Set<string>>(new Set());
  const [downloadToast, setDownloadToast] = useState<string | null>(null);

  const explainTopicMeaning = async (topicText: string, opts?: { kind?: "topic" | "vocab"; knownMeaning?: string }) => {
    const t = topicText.trim();
    if (!t) return;
    // simple cache by exact text
    const cached = topicMeaningCacheRef.current.get(t);
    if (cached) {
      setAnswer(`${opts?.kind ?? "topic"}: ${t}\n\n${cached}`);
      return;
    }
    if (topicMeaningInFlightRef.current.has(t)) return;
    topicMeaningInFlightRef.current.add(t);
    try {
      setAnswer(`${opts?.kind ?? "topic"}: ${t}\n\nGenerating explanation...`);
      const ctx = buildContextSnippet(t, regionRecognizedText || "");
      const carry = (ocrCarryOverRef.current || "").trim();
      const prompt = [
        `Explain the term/phrase. Disambiguate based on context and avoid generic encyclopedia definitions.`,
        ``,
        `Term: ${t}`,
        opts?.knownMeaning ? `Known short meaning: ${opts.knownMeaning}` : "",
        `PageIndex: ${pageIndex}`,
        carry ? `Cross-page carry-over (prev page tail): ${carry}` : "",
        ctx ? `Context snippet: ${ctx}` : `${regionRecognizedText}`,
        ``,
        `Output requirements:`,
        `- First: 1-sentence meaning`,
        `- Keep it concise`,
      ].filter(Boolean).join("\n");
      const resp = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: t,
          prompt,
          level: "light",
          streaming: false,
          language: "en",
        }),
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.error("[TopicMeaning] /api/llm error", resp.status, txt);
        return;
      }
      const data = await resp.json();
      const content: string = data?.content || "";
      if (content) {
        topicMeaningCacheRef.current.set(t, content);
        setAnswer(`${opts?.kind ?? "topic"}: ${t}\n\n${content}`);
      }
    } catch (e) {
      console.error("[TopicMeaning] unexpected error", e);
    } finally {
      topicMeaningInFlightRef.current.delete(t);
    }
  };

  const handleTopicSelection = (
    topicText: string,
    source: "page_topic" | "voice",
    timestamp = Date.now()
  ) => {
    const normalized = topicText.trim();
    if (!normalized) return;

    sessionLogger.addSelectedTopic({
      id: `${source === "voice" ? "voice-topic" : "topic"}-${timestamp}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      timestamp,
      text: normalized,
      source,
    });
    pushSelectedTopic(normalized, timestamp);
    setLastSelectedTopic(normalized);
    explainTopicMeaning(normalized, { kind: "topic" });
    setTimeout(() => setLastSelectedTopic(null), 1500);
  };

  // Interest detection config
  const interestDetectionConfig = {
    trailMaxLength: 1000, // Max trail length
    speedThreshold: {
      slow: 0.5,    // Slow threshold (px/ms)
      fast: 3.0     // Fast threshold (px/ms)
    },
    stayTimeThreshold: 500, // Dwell time threshold (ms)
    heatmapGridSize: 20,    // Heatmap grid size (px)
    interestDecayRate: 0.95, // Interest decay rate
    minInterestScore: 0.1   // Minimum interest score
  };

  // Core interest detection helpers
  const calculateSpeed = (point1: {x: number, y: number, timestamp: number}, point2: {x: number, y: number, timestamp: number}): number => {
    const distance = Math.hypot(point2.x - point1.x, point2.y - point1.y);
    const timeDiff = point2.timestamp - point1.timestamp;
    return timeDiff > 0 ? distance / timeDiff : 0;
  };

  const updateMovementTrail = (x: number, y: number) => {
    const timestamp = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const newPoint = { x, y, timestamp, speed: 0 };
    
    setMovementTrail(prevTrail => {
      let updatedTrail = [...prevTrail];
      
      // Compute speed
      if (updatedTrail.length > 0) {
        const lastPoint = updatedTrail[updatedTrail.length - 1];
        newPoint.speed = calculateSpeed(lastPoint, newPoint);
      }
      
      updatedTrail.push(newPoint);
      
      // Limit trail length
      if (updatedTrail.length > interestDetectionConfig.trailMaxLength) {
        updatedTrail = updatedTrail.slice(-interestDetectionConfig.trailMaxLength);
      }
      
      return updatedTrail;
    });
  };

  // rAF sampling: update trail at ~60fps when interest detection is enabled
  useEffect(() => {
    if (!isInterestDetectionEnabled) return;
    let rafId: number | null = null;
    const tick = () => {
      if (fingerTipPosition) {
        updateMovementTrail(fingerTipPosition.x, fingerTipPosition.y);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isInterestDetectionEnabled, fingerTipPosition?.x, fingerTipPosition?.y]);

  const calculateInterestScore = (trail: Array<{x: number, y: number, timestamp: number, speed: number}>): number => {
    if (trail.length < 2) return 0;
    
    let totalScore = 0;
    let slowMovementCount = 0;
    let stayTimeCount = 0;
    
    // Analyze behavior of the last 10 points
    const recentPoints = trail.slice(-10);
    
    for (let i = 1; i < recentPoints.length; i++) {
      const point = recentPoints[i];
      const prevPoint = recentPoints[i - 1];
      
      // Speed analysis
      if (point.speed < interestDetectionConfig.speedThreshold.slow) {
        slowMovementCount++;
      }
      
      // Dwell time analysis
      const timeDiff = point.timestamp - prevPoint.timestamp;
      if (timeDiff > interestDetectionConfig.stayTimeThreshold) {
        stayTimeCount++;
      }
    }
    
    // Compute interest score
    const speedScore = slowMovementCount / recentPoints.length; // 0-1
    const stayScore = stayTimeCount / recentPoints.length; // 0-1
    const densityScore = Math.min(trail.length / 50, 1); // Trail density score
    
    totalScore = (speedScore * 0.4 + stayScore * 0.4 + densityScore * 0.2) * 100;
    
    return Math.min(totalScore, 100);
  };

  const updateInterestHeatmap = (x: number, y: number, score: number) => {
    const gridSize = interestDetectionConfig.heatmapGridSize;
    const gridX = Math.floor(x / gridSize);
    const gridY = Math.floor(y / gridSize);
    const gridKey = `${gridX},${gridY}`;
    
    setInterestHeatmap(prevHeatmap => {
      const newHeatmap = new Map(prevHeatmap);
      const currentScore = newHeatmap.get(gridKey) || 0;
      const newScore = Math.min(currentScore + score, 100);
      
      if (newScore > interestDetectionConfig.minInterestScore) {
        newHeatmap.set(gridKey, newScore);
      } else {
        newHeatmap.delete(gridKey);
      }
      
      return newHeatmap;
    });
  };

  const extractKeywordsFromArea = async (x: number, y: number, radius: number = 50): Promise<string[]> => {
    try {
      // Extract keywords combined with OCR results
      if (answer && answer.length > 0) {
        // Simple keyword extraction logic
        const words = answer
          .split(/[\s,.;:!?]+/)
          .map((word) => word.trim().toLowerCase())
          .filter(
            (word) =>
              word.length > 1 &&
              !["the", "and", "for", "with", "that", "this", "from", "into", "are", "you"].includes(word)
          );
        
        // Return the top 5 longest words as keywords
        return words
          .sort((a, b) => b.length - a.length)
          .slice(0, 5)
          .map(word => word.trim());
      }
      
      // If no OCR results, return mock keywords
      const keywords = ["tech", "innovation", "ai", "ux", "design", "algorithm", "data", "analysis", "system", "application"];
      return keywords.slice(0, Math.floor(Math.random() * 3) + 1);
    } catch (error) {
      console.error('keyword extraction failed', error);
      return [];
    }
  };

  const analyzeInterestPatterns = async () => {
    if (movementTrail.length < 5) return;
    
    const totalScore = calculateInterestScore(movementTrail);
    const averageSpeed = movementTrail.reduce((sum, point) => sum + point.speed, 0) / movementTrail.length;
    
    // Identify focus areas
    const focusAreas: Array<{x: number, y: number, radius: number, score: number}> = [];
    const heatmapEntries = Array.from(interestHeatmap.entries());
    
    for (const [key, score] of heatmapEntries) {
      if (score > 20) { // Only show high-score areas
        const [gridX, gridY] = key.split(',').map(Number);
        const x = gridX * interestDetectionConfig.heatmapGridSize;
        const y = gridY * interestDetectionConfig.heatmapGridSize;
        focusAreas.push({ x, y, radius: 30, score });
      }
    }
    
    // Extract keywords
    const keywords = await extractKeywordsFromArea(0, 0, 100);
    const topKeywords = keywords.map(keyword => ({
      keyword,
      score: Math.random() * 50 + 20 // Simulated score
    }));
    
    setInterestAnalysis({
      totalInterestScore: totalScore,
      averageSpeed,
      focusAreas,
      topKeywords
    });
  };

  // Stable realtime speed (total distance/time of last 8 points, px/s)
  const stableRealtimeSpeedPxPerSec = useMemo(() => {
    const n = movementTrail.length;
    if (n < 3) return 0;
    const windowSize = Math.min(8, n - 1);
    const startIdx = n - 1 - windowSize;
    const segment = movementTrail.slice(startIdx);
    let totalDist = 0;
    for (let i = 1; i < segment.length; i++) {
      totalDist += Math.hypot(segment[i].x - segment[i-1].x, segment[i].y - segment[i-1].y);
    }
    const totalTime = segment[segment.length - 1].timestamp - segment[0].timestamp;
    if (totalTime <= 0) return 0;
    return (totalDist / totalTime) * 1000; // px/s
  }, [movementTrail]);

  // Detect device info
  useEffect(() => {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isIPad = /iPad/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
    const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua);
    
    const info = `device: ${isIPad ? 'iPad' : isIOS ? 'iPhone' : 'other'} | browser: ${isSafari ? 'Safari' : 'other'} | touch points: ${navigator.maxTouchPoints}`;
    setDeviceInfo(info);
    console.log('[Device]', info);
  }, []);

  // Add mobile debugging tool
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/eruda@3/eruda.js';
    script.onload = () => {
      (window as any).eruda?.init();
    };
    document.head.appendChild(script);
    
    return () => {
      document.head.removeChild(script);
    };
  }, []);

  // 1) start camera (iPad needs HTTPS or localhost)
  useEffect(() => {
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: PRESSURE_CAMERA_CONSTRAINTS,
          audio: false,
        });
        const v = videoRef.current!;
        v.srcObject = stream;
        v.muted = true;
        // wait for metadata to be ready before playing, ensure videoWidth/Height
        v.onloadedmetadata = async () => {
          try {
            await v.play();
            
            // Try to enable autofocus
            try {
              const videoTrack = stream.getVideoTracks()[0];
              const capabilities = videoTrack.getCapabilities() as any;
              console.log('[Camera] 鎽勫儚澶磋兘鍔?', capabilities);
              
              // If focus is supported, enable continuous autofocus
              if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
                await videoTrack.applyConstraints({
                  advanced: [{ focusMode: 'continuous' } as any]
                });
                console.log('[Camera] enabled continuous autofocus');
              } else if (capabilities.focusMode && capabilities.focusMode.includes('single-shot')) {
                await videoTrack.applyConstraints({
                  advanced: [{ focusMode: 'single-shot' } as any]
                });
                console.log('[Camera] enabled single-shot autofocus');
              } else {
                console.log('[Camera] 鈿狅笍 璁惧涓嶆敮鎸佽嚜鍔ㄥ鐒︽帶鍒讹紝灏濊瘯鎵嬪姩瀵圭劍...');
                
                // If manual focus distance is supported
                if (capabilities.focusDistance) {
                  // Set a mid focus distance (often good for reading documents)
                  const midDistance = (capabilities.focusDistance.min + capabilities.focusDistance.max) / 2;
                  await videoTrack.applyConstraints({
                    advanced: [{ focusDistance: midDistance } as any]
                  });
                  console.log('[Camera] set manual focus distance', midDistance);
                } else {
                  console.log('[Camera] device does not support focus control');
                }
              }
              
              // If white balance is supported, set to auto
              if (capabilities.whiteBalanceMode && capabilities.whiteBalanceMode.includes('continuous')) {
                await videoTrack.applyConstraints({
                  advanced: [{ whiteBalanceMode: 'continuous' } as any]
                });
                console.log('[Camera] enabled auto white balance');
              }
              
              // If exposure is supported, set to auto
              if (capabilities.exposureMode && capabilities.exposureMode.includes('continuous')) {
                await videoTrack.applyConstraints({
                  advanced: [{ exposureMode: 'continuous' } as any]
                });
                console.log('[Camera] enabled auto exposure');
              }
              
            } catch (constraintError) {
              console.warn('[Camera] 璁剧疆鎽勫儚澶寸害鏉熷け璐?', constraintError);
            }
            
            setVideoReady(true);
            
            // Delay Three.js init to ensure video playback started
            setTimeout(() => {
              initThreeRenderer();
            }, 300);
          } catch (e) {
            console.error("play() failed", e);
          }
        };
      } catch (e) {
        console.error("Camera error", e);
      }
    })();
  }, []);
  
  // Initialize Three.js renderer (for realtime 3D)
  const initThreeRenderer = () => {
    const video = videoRef.current;
    const canvas = threeCanvasRef.current;
    
    if (!video || !canvas || video.videoWidth === 0) {
      console.warn('[Three.js Init] Video not ready, delaying init');
      setTimeout(initThreeRenderer, 500);
      return;
    }
    
    console.log('[Three.js Init] Starting Three.js realtime renderer init');
    
    const containerWidth = 1000;
    const containerHeight = 1000;
    
    // Create renderer
    const renderer = new THREE.WebGLRenderer({ 
      canvas,
      antialias: true,
      alpha: false
    });
    // Handle high-DPR devices to match CSS pixels
    renderer.setPixelRatio(Math.max(1, window.devicePixelRatio || 1));
    renderer.setSize(containerWidth, containerHeight, false);
    renderer.setClearColor(0x000000, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    threeRendererRef.current = renderer;
    
    // Create scene
    const scene = new THREE.Scene();
    threeSceneRef.current = scene;
    
    // Create camera (Perspective, matches CSS perspective(800px))
    const fov = 2 * Math.atan(containerHeight / (2 * 800)) * 180 / Math.PI; // FOV derived from perspective(800px)
    const aspect = containerWidth / containerHeight;
    const near = 0.1;
    const far = 5000;
    const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
    camera.position.set(0, 0, 800); // Camera Z = perspective distance
    camera.lookAt(0, 0, 0);
    threeCameraRef.current = camera;
    
    // Create video texture
    const videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.format = THREE.RGBAFormat;
    videoTexture.colorSpace = THREE.SRGBColorSpace;
    threeTextureRef.current = videoTexture;
    
    // Compute video plane size
    const videoAspect = video.videoWidth / video.videoHeight;
    const containerAspect = containerWidth / containerHeight;
    
    let planeWidth, planeHeight;
    if (videoAspect > containerAspect) {
      planeWidth = containerWidth;
      planeHeight = containerWidth / videoAspect;
    } else {
      planeHeight = containerHeight;
      planeWidth = containerHeight * videoAspect;
    }
    
    // Create plane (put under pivot to rotate around top)
    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    // Custom shader material: non-linear Y compensation after rotateX to reduce line compression
    const uniforms = {
      u_map: { value: videoTexture as THREE.Texture },
      u_comp: { value: warpCompensation }, // Suggested 0~0.5
    };
    shaderUniformsRef.current = uniforms as any;
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `
        varying vec2 v_uv;
        void main() {
          v_uv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;
        uniform sampler2D u_map;
        uniform float u_comp; // 0 disables, higher = stronger compensation
        varying vec2 v_uv;
        void main() {
          // Lower y compresses more; apply inverse stretch compensation
          float scale = 1.0 / mix(1.0, 1.0 + u_comp, 1.0-v_uv.y);
          float cy = 0.85; // Anchor closer to the top hinge (v_uv.y uses bottom=0, top=1)
          float y = (v_uv.y - cy) * scale + cy; // Non-linear stretch around anchor
          vec2 uv2 = vec2(v_uv.x, clamp(y, 0.0, 1.0));
          gl_FragColor = texture2D(u_map, uv2);
        }
      `,
      transparent: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0, -planeHeight / 2, 0); // Shift plane down so pivot is at top
    threeMeshRef.current = mesh;
    mesh.scale.x *= -1; // Mirror horizontally
    const pivot = new THREE.Object3D();
    pivot.position.set(0, planeHeight / 2, 0); // Top as pivot
    pivot.add(mesh);
    scene.add(pivot);
    threePivotRef.current = pivot;
    threePivotBaseYRef.current = pivot.position.y;
    // Apply initial transform (avoid needing user interaction)
    try {
      // Translation
      pivot.position.x = videoTranslate.x;
      pivot.position.y = threePivotBaseYRef.current - videoTranslate.y;
      // Scale (keep horizontal mirror)
      mesh.scale.set(videoScale, videoScale, 1);
      mesh.scale.x *= -1;
      // Perspective rotation
      const rotationAngle = -(perspectiveStrength / 100) * (Math.PI / 6);
      pivot.rotation.x = rotationAngle;
      // Camera position (match CSS perspective(800px))
      camera.position.set(0, 0, 800);
      camera.lookAt(0, 0, 0);
      // Compensation strength
      if (shaderUniformsRef.current) {
        shaderUniformsRef.current.u_comp.value = warpCompensation;
      }
    } catch {}
    
    console.log('[Three.js Init] Three.js renderer initialized, plane size:', planeWidth, 'x', planeHeight);
    
    // Start animation loop
    startThreeAnimation();
  };
  
  // Three.js animation loop
  const startThreeAnimation = () => {
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      
      const renderer = threeRendererRef.current;
      const scene = threeSceneRef.current;
      const camera = threeCameraRef.current;
      const texture = threeTextureRef.current;
      const mesh = threeMeshRef.current;
      
      if (!renderer || !scene || !camera || !mesh) return;
      
      // Update video texture
      if (texture) {
        texture.needsUpdate = true;
      }
      
      renderer.render(scene, camera);
    };
    animate();
  };

  // ===== Warp compensation: rebuild per shader formula and invert in top-based coordinates =====
  // Shader code (note v_uv.y uses bottom=0, top=1):
  //   float scale = 1.0 / mix(1.0, 1.0 + u_comp, 1.0 - v_uv.y);
  //   float cy = WARP_CY;
  //   float y  = (v_uv.y - cy) * scale + cy;
  //   vec2 uv2 = vec2(v_uv.x, clamp(y, 0.0, 1.0));
  //
  // MediaPipe v uses top=0, bottom=1 (top-based). The shader operates in bottom-based UV (0=bottom,1=top).
  // For fingertip projection, we must invert the SAME warp used in the fragment shader; otherwise,
  // when warp is enabled the marker will drift vertically (even if rotate/scale/translate are correct).
  //
  // Keep shader + JS inversion perfectly in sync.
  const WARP_CY = 0.85; // bottom-based UV anchor (1=top). Helps reduce "top/bottom wide, middle narrow" feel.

  // Analytic inverse (matches shader exactly, ignoring clamp):
  // Shader forward mapping in bottom-based coords (s = v_uv.y, yTex = uv2.y):
  //   scale = 1 / (1 + c*(1 - s))
  //   yTex  = cy + (s - cy)*scale
  // Solve for s given yTex:
  //   s = ((1+c)*yTex - c*cy) / (1 + c*(yTex - cy))
  //
  // We expose the inversion in top-based coords:
  //   vTop (MediaPipe) -> yTex(bottom-based)=1-vTop -> s -> vPlaneTop = 1-s
  const invertVerticalWarp = (vTopSample: number, comp: number): number => {
    const vTop = Math.min(1, Math.max(0, vTopSample));
    if (comp <= 0) return vTop;
    const yTex = 1 - vTop; // bottom-based texture coord
    const denom = 1 + comp * (yTex - WARP_CY);
    if (Math.abs(denom) < 1e-6) return vTop;
    const s = ((1 + comp) * yTex - comp * WARP_CY) / denom; // plane UV (bottom-based)
    const vPlaneTop = 1 - s; // convert back to top-based
    return Math.min(1, Math.max(0, vPlaneTop));
  };

  // Map MediaPipe normalized video coords (u,v in [0,1]) to overlay screen coords
  const projectVideoUVToOverlay = (u: number, v: number): {x: number; y: number} | null => {
    const renderer = threeRendererRef.current;
    const camera = threeCameraRef.current;
    const mesh = threeMeshRef.current;
    if (!renderer || !camera || !mesh) return null;

    // Read latest compensation from ref to avoid stale MediaPipe closures
    const comp = warpCompensationRef.current;

    // Note: MediaPipe gives "original video coords" (shader uv2.y),
    // while the Three.js plane uses v_uv.y as its param.
    // We need v_uv.y such that warp(v_uv.y) 鈮?v (final line position),
    // so we invert the warp to map v back to plane param coords.
    const vPlane = invertVerticalWarp(v, comp);

    // Get plane size
    const geom = mesh.geometry as THREE.PlaneGeometry;
    const planeWidth = geom.parameters.width as number;
    const planeHeight = geom.parameters.height as number;
    // Video UV 鈫?mesh local coords (origin at video center, +X right, +Y up)
    const localX = (u - 0.5) * planeWidth;
    // const localY = (0.5 - v) * planeHeight; // v down 鈫?Three up (old)
    const localY = (0.5 - vPlane) * planeHeight; // v down 鈫?Three up (using inverted vPlane)
    const local = new THREE.Vector3(localX, localY, 0);
    // To world coordinates
    const world = local.clone().applyMatrix4(mesh.matrixWorld);
    // Project to NDC
    const ndc = world.clone().project(camera);
    // NDC 鈫?screen pixels (using renderer canvas CSS size)
    const cssW = renderer.domElement.clientWidth || 500;
    const cssH = renderer.domElement.clientHeight || 500;
    const x = (ndc.x * 0.5 + 0.5) * cssW;
    const y = (-ndc.y * 0.5 + 0.5) * cssH;
    return { x, y };
  };

  // Helper: WYSIWYG crop from Three.js canvas by region (with DPR)
  const captureWYSIWYGRegion = (region: {left: number; top: number; width: number; height: number}) => {
    const renderer = threeRendererRef.current;
    const scene = threeSceneRef.current;
    const camera = threeCameraRef.current;
    if (!renderer || !scene || !camera) return null;
    // Force a render to ensure content is current
    renderer.render(scene, camera);
    const source = renderer.domElement;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const sx = Math.floor(region.left * dpr);
    const sy = Math.floor(region.top * dpr);
    const sw = Math.floor(region.width * dpr);
    const sh = Math.floor(region.height * dpr);
    if (sw <= 0 || sh <= 0) return null;
    const out = document.createElement('canvas');
    out.width = sw; out.height = sh;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    return out;
  };

  // High-res WYSIWYG crop: render offscreen at scale then crop
  const captureWYSIWYGRegionHiRes = (region: {left: number; top: number; width: number; height: number}, scale: number = 2) => {
    const baseRenderer = threeRendererRef.current;
    const scene = threeSceneRef.current;
    const camera = threeCameraRef.current;
    if (!baseRenderer || !scene || !camera) return null;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = baseRenderer.domElement.clientWidth || 500;
    const cssH = baseRenderer.domElement.clientHeight || 500;
    // Reuse offscreen renderer
    let off = offscreenRendererRef.current;
    if (!off) {
      off = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      off.outputColorSpace = THREE.SRGBColorSpace;
      offscreenRendererRef.current = off;
    }
    off.setPixelRatio(dpr);
    off.setSize(cssW * scale, cssH * scale, false);
    off.render(scene, camera);
    const src = off.domElement;
    const sx = Math.floor(region.left * dpr * scale);
    const sy = Math.floor(region.top * dpr * scale);
    const sw = Math.floor(region.width * dpr * scale);
    const sh = Math.floor(region.height * dpr * scale);
    if (sw <= 0 || sh <= 0) { return null; }
    // Reuse crop canvas
    let out = captureCanvasRef.current;
    if (!out) {
      out = document.createElement('canvas');
      captureCanvasRef.current = out;
    }
    out.width = sw; out.height = sh;
    const ctx = out.getContext('2d');
    if (!ctx) { return null; }
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
    return out;
  };
  
  // Watch transform params and update Three.js scene (pivot simulates CSS transform-origin: top)
  useEffect(() => {
    const mesh = threeMeshRef.current;
    const pivot = threePivotRef.current;
    const camera = threeCameraRef.current;
    
    if (!mesh || !pivot || !camera) return;
    
    // Match CSS order: transform-origin: top 鈫?translate 鈫?scale/flip 鈫?rotateX
    // 1) Translate (relative to pivot, keep top pivot baseline)
    pivot.position.x = videoTranslate.x;
    pivot.position.y = threePivotBaseYRef.current - videoTranslate.y;
    // In the transform update effect (same as pivot.position.y)


    
    // 2) Scale
    mesh.scale.set(videoScale, videoScale, 1);
    mesh.scale.x *= -1; // Horizontal mirror
    
    // 3) Perspective rotation: negative X rotation (bottom grows)
    const rotationAngle = -(perspectiveStrength / 100) * (Math.PI / 6); // 0 to -20 degrees
    pivot.rotation.x = rotationAngle;
    
    // 4) Camera matches CSS perspective(800px)
    camera.position.set(0, 0, 800);
    camera.lookAt(0, 0, 0);
    // Update compensation strength
    if (shaderUniformsRef.current) {
      shaderUniformsRef.current.u_comp.value = warpCompensation;
    }
    
  }, [videoScale, videoTranslate, perspectiveStrength, warpCompensation]);

  // 2) initialize OCR
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        console.log('[OCR] start initializing Tesseract.js...');
        
        // v5+ usage: pass language code directly, no extra config
        const w = await createWorker('eng', 1, {
          logger: (m: any) => console.log('[tesseract]', m),
        });
        
        console.log('[OCR] Worker initialized!');
  
        if (!mounted) {
          console.log('[OCR] component unmounted, terminate worker');
          await w.terminate();
          return;
        }
        setWorker(w);
        setOcrReady(true);
        console.log('[OCR] OCR engine ready');
        
      } catch (err) {
        console.error('[OCR] Tesseract initialization failed:', err);
        setAnswer(`OCR initialization failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    
    return () => { 
      mounted = false; 
      if (worker) {
        worker.terminate().catch(console.error);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3) Create/destroy MediaPipe Hands instance (depends only on enabled state)
  useEffect(() => {
    if (!isHandDetectionEnabled) {
      // Clean up existing instance
      if (handsInstance) {
        handsInstance.close();
        setHandsInstance(null);
      }
      setHandResults(null);
      setFingerTipPosition(null);
      setFingerTipUv(null);
      return;
    }

    let mounted = true;
    
    const initializeHandDetection = async () => {
      try {
        console.log('[HandDetection] Starting MediaPipe Hands init...');
        
        // Load MediaPipe Hands via CDN
        if (!(window as any).Hands) {
          // Dynamically load MediaPipe script
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js';
          
          await new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
          });
          
          console.log('[HandDetection] MediaPipe script loaded');
        }
        
        if (!mounted) return;
        
        const hands = new (window as any).Hands({
          locateFile: (file: string) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
          }
        });
        
        hands.setOptions({
          maxNumHands: 1, // Detect only one hand
          modelComplexity: handDetectionConfig.modelComplexity, // Use configured model complexity
          minDetectionConfidence: handDetectionConfig.minDetectionConfidence, // Use configured detection confidence
          minTrackingConfidence: handDetectionConfig.minTrackingConfidence,  // Use configured tracking confidence
          selfieMode: false, // Disable selfie mode (avoid extra mirroring)
          staticImageMode: false // Use video mode, not static image mode
        });
        
        hands.onResults((results: any) => {
          if (!mounted) return;
          
          setHandResults(results);
          
          if (results.multiHandLandmarks && results.multiHandLandmarks[0]) {
            const landmarks = results.multiHandLandmarks[0];
            // Get index fingertip coords (landmark 8)
            const fingerTip = landmarks[8];
            
            // Convert to pixel coords (account for actual display area)
            const videoContainer = document.querySelector('.video-container') as HTMLElement;
            const video = videoRef.current;
            if (videoContainer && video) {
              const containerRect = videoContainer.getBoundingClientRect();
              
              // Key: compute actual video display region in container
              const videoAspect = video.videoWidth / video.videoHeight;
              const containerAspect = containerRect.width / containerRect.height;
              
              let videoDisplayWidth, videoDisplayHeight, videoOffsetX, videoOffsetY;
              
              if (videoAspect > containerAspect) {
                // Video is wider; use container width
                videoDisplayWidth = containerRect.width;
                videoDisplayHeight = containerRect.width / videoAspect;
                videoOffsetX = 0;
                videoOffsetY = (containerRect.height - videoDisplayHeight) / 2;
              } else {
                // Video is taller; use container height
                videoDisplayHeight = containerRect.height;
                videoDisplayWidth = containerRect.height * videoAspect;
                videoOffsetX = (containerRect.width - videoDisplayWidth) / 2;
                videoOffsetY = 0;
              }
              
              // Use Three.js projection to get overlay pixel coords
              const projected = projectVideoUVToOverlay(fingerTip.x, fingerTip.y);
              if (!projected) {
                setFingerTipPosition(null);
                setFingerTipUv(null);
                return;
              }
              let { x, y } = projected;
              setFingerTipUv(normalizePressureFingertipUv(fingerTip));

              // Visual compensation for lower fingertip:
              // - MediaPipe fingerTip.y is 0~1 (0=top, 1=bottom)
              // - Lower positions look stretched by perspective/warp; marker appears mid-nail
              // Apply an offset that grows with y, only for fingerTipPosition
              // (does not affect video or capture region).
              // const extraY = fingerCompStrengthRef.current * (-fingerTip.y) * containerRect.height;
              // Scale compensation with current zoom (mesh scale), mildly, so it stays stable after pinch-zoom
              const zoomFactor = threeMeshRef.current?.scale?.y ?? 1;
              const zoomScale = Math.pow(Math.max(0.01, zoomFactor), fingerCompZoomExp);

              const yClamped = Math.min(1, Math.max(0, fingerTip.y));
              const tRaw = (yClamped - fingerCompYMin) / (fingerCompYMax - fingerCompYMin);
              const t = Math.min(1, Math.max(0, tRaw));
              // yBalance(t) = 1 + k*(0.5 - t)
              // - top (t<0.5): >1  => more comp
              // - bottom (t>0.5): <1 => less comp
              const yBalance = 1 + fingerCompYBalance * (0.5 - t);

              const extraY =
                fingerCompStrengthRef.current *
                (-yClamped) *
                containerRect.height *
                zoomScale *
                yBalance;
              y += extraY;

              // === Fingertip smoothing: low-pass + small jitter dead zone ===
              // rawPos: pixel coords after geometry + visual compensation
              const rawPos = { x: x - 5, y }; // 5px horizontal shift to align marker to edge
              let smoothedPos = rawPos;
              const prev = fingerTipPositionRef.current;
              if (prev) {
                const dx = rawPos.x - prev.x;
                const dy = rawPos.y - prev.y;
                const dist = Math.hypot(dx, dy);
                const deadZonePx = 2; // <=2px treated as jitter; lock to previous frame
                if (dist < deadZonePx) {
                  smoothedPos = prev;
                } else {
                  const alpha = 0.5; // 0~1: smaller is smoother but less responsive
                  smoothedPos = {
                    x: prev.x + alpha * dx,
                    y: prev.y + alpha * dy,
                  };
                }
              }

              setFingerTipPosition(smoothedPos);
              
              // Interest detection: update movement trail with smoothed coords
              if (isInterestDetectionEnabled) {
                updateMovementTrail(smoothedPos.x, smoothedPos.y);
                
                // Compute current interest score
                const currentScore = calculateInterestScore(movementTrail);
                setCurrentInterestScore(currentScore);
                
                // Update interest heatmap
                if (currentScore > 10) {
                  updateInterestHeatmap(x, y, currentScore);
                }
              }
              
              // Long-press detection logic (use refs to reduce setState)
              if (isFingerLongPressLLMEnabledRef.current) {
                const currentTime = Date.now();
                //const newPosition = { x, y };
                const newPosition = smoothedPos;
                
                // Check if still in the same position (within tolerance)
                if (longPressRef.current.startPosition) {
                  const distance = Math.sqrt(
                    Math.pow(newPosition.x - longPressRef.current.startPosition.x, 2) + 
                    Math.pow(newPosition.y - longPressRef.current.startPosition.y, 2)
                  );
                  
                  if (distance <= longPressConfig.positionTolerance) {
                    // Same position; update duration
                    const duration = currentTime - longPressRef.current.startTime;
                    let currentLevel: Level = 'light';
                    
                    if (duration >= longPressConfig.hardThreshold) {
                      currentLevel = 'hard';
                    } else if (duration >= longPressConfig.mediumThreshold) {
                      currentLevel = 'medium';
                    } else if (duration >= longPressConfig.lightThreshold) {
                      currentLevel = 'light';
                    }
                    
                    // Update ref
                    longPressRef.current.currentLevel = currentLevel;
                    
                    // Take screenshot at light level (once)
                    if (duration >= longPressConfig.lightThreshold && !longPressRef.current.hasScreenshot) {
                      takeFingerScreenshot(newPosition);
                    }
                    
                    // Only setState when UI needs update (reduce frequency)
                    const isActive = duration >= longPressConfig.autoTriggerDelay;
                    if (longPressState.isActive !== isActive || 
                        longPressState.currentLevel !== currentLevel ||
                        Math.abs(longPressState.currentDuration - duration) > 100) { // Update UI every 100ms
                      setLongPressState(prev => ({
                        ...prev,
                        isActive,
                        currentDuration: duration,
                        currentLevel,
                        shouldTriggerOnMove: false,
                        startPosition: newPosition
                      }));
                    }
                  } else {
                    // Position change too large; mark for OCR trigger
                    const shouldTrigger = !longPressRef.current.hasTriggered && 
                                         (currentTime - longPressRef.current.startTime) >= longPressConfig.autoTriggerDelay;
                    
                    // Reset ref
                    longPressRef.current = {
                      startTime: currentTime,
                      startPosition: newPosition,
                      currentLevel: 'light',
                      hasTriggered: false,
                      hasScreenshot: false
                    };
                    
                    // Update state
                    const triggerLevel = shouldTrigger ? longPressRef.current.currentLevel : false;
                    setLongPressState({
                      isActive: false,
                      currentDuration: 0,
                      currentLevel: 'light',
                      shouldTriggerOnMove: triggerLevel,
                      startPosition: null
                    });
                  }
                } else {
                  // First time fingertip detected
                  longPressRef.current = {
                    startTime: currentTime,
                    startPosition: newPosition,
                    currentLevel: 'light',
                    hasTriggered: false,
                    hasScreenshot: false
                  };
                  
                  setLongPressState({
                    isActive: false,
                    currentDuration: 0,
                    currentLevel: 'light',
                    shouldTriggerOnMove: false,
                    startPosition: null
                  });
                }
              }
              
              // console.log('[HandDetection] Fingertip position (with aspect correction):', { 
              //   rawMediaPipe: { x: fingerTip.x.toFixed(3), y: fingerTip.y.toFixed(3) },
              //   videoSize: { w: video.videoWidth, h: video.videoHeight, aspect: videoAspect.toFixed(2) },
              //   containerSize: { w: containerRect.width, h: containerRect.height, aspect: containerAspect.toFixed(2) },
              //   displayArea: { w: videoDisplayWidth.toFixed(1), h: videoDisplayHeight.toFixed(1), offsetX: videoOffsetX.toFixed(1), offsetY: videoOffsetY.toFixed(1) },
              //   finalCoord: { x: x.toFixed(1), y: y.toFixed(1) },
              //   transforms: { scale: videoScale.toFixed(2), translateX: videoTranslate.x.toFixed(1), translateY: videoTranslate.y.toFixed(1) }
              // });
            }
          } else {
            setFingerTipPosition(null);
            setFingerTipUv(null);
            // Reset long-press state when finger disappears
            const shouldTrigger = !longPressRef.current.hasTriggered && 
                                 longPressRef.current.startPosition &&
                                 (Date.now() - longPressRef.current.startTime) >= longPressConfig.autoTriggerDelay;
            
            // Reset ref
            const triggerLevel = shouldTrigger ? longPressRef.current.currentLevel : false;
            longPressRef.current = {
              startTime: 0,
              startPosition: null,
              currentLevel: 'light',
              hasTriggered: false,
              hasScreenshot: false
            };
            
            // Update state
            setLongPressState({
              isActive: false,
              currentDuration: 0,
              currentLevel: 'light',
              shouldTriggerOnMove: triggerLevel,
              startPosition: null
            });
          }
        });
        
        if (!mounted) return;
        
        setHandsInstance(hands);
        console.log('[HandDetection] 鉁?MediaPipe Hands initialized');
        
        // Start processing video frames (optimize frame rate)
        let lastFrameTime = 0;
        const targetFPS = 30; // Target FPS
        const frameInterval = 1000 / targetFPS;
        
        const processFrame = async (currentTime: number = 0) => {
          const video = videoRef.current;
          
          // Throttle frame rate to avoid over-processing
          if (currentTime - lastFrameTime >= frameInterval) {
            if (video && video.readyState >= 2 && mounted && isHandDetectionEnabled) {
              try {
                await hands.send({ image: video });
                lastFrameTime = currentTime;
              } catch (error) {
                console.warn('[HandDetection] 澶勭悊甯уけ璐?', error);
              }
            }
          }
          
          if (mounted && isHandDetectionEnabled) {
            requestAnimationFrame(processFrame);
          }
        };
        
        processFrame();
        
      } catch (error) {
        console.error('[HandDetection] MediaPipe Hands 鍒濆鍖栧け璐?', error);
        setDebugInfo(`hand detection initialization failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    
    initializeHandDetection();
    
    return () => {
      mounted = false;
      if (handsInstance) {
        try {
          handsInstance.close();
        } catch (error) {
        console.warn('[HandDetection] Error while cleaning instance:', error);
        }
      }
    };
  }, [isHandDetectionEnabled]); // Only depend on enabled state

  // 4) MediaPipe Hands config updates (no instance rebuild)
  useEffect(() => {
    if (handsInstance && isHandDetectionEnabled) {
      console.log('[HandDetection] Updating config:', handDetectionConfig);
      handsInstance.setOptions({
        maxNumHands: 1,
        modelComplexity: handDetectionConfig.modelComplexity,
        minDetectionConfidence: handDetectionConfig.minDetectionConfidence,
        minTrackingConfidence: handDetectionConfig.minTrackingConfidence,
        selfieMode: false,
        staticImageMode: false
      });
    }
  }, [handsInstance, handDetectionConfig, isHandDetectionEnabled]);

  // Auto-trigger OCR on long-press (only at hard level)
  useEffect(() => {
    if (!isFingerLongPressLLMEnabled) return;

    if (longPressState.isActive && 
        longPressState.currentLevel === 'hard' &&
        longPressState.currentDuration >= longPressConfig.hardThreshold && 
        !longPressRef.current.hasTriggered && 
        fingerTipPosition && 
        !isProcessing) {
      
      console.log('[LongPress] Auto-trigger OCR at hard level, duration:', longPressState.currentDuration);
      
      // Mark as triggered
      longPressRef.current.hasTriggered = true;
      
      // Set to hard level
      setLevel('hard');
      
      // Trigger OCR
      onFingerSelection();
    }
  }, [isFingerLongPressLLMEnabled, longPressState.isActive, longPressState.currentDuration, longPressState.currentLevel, fingerTipPosition, isProcessing]);

  // Periodically analyze interest patterns
  useEffect(() => {
    if (!isInterestDetectionEnabled || movementTrail.length < 10) return;
    
    const analysisInterval = setInterval(() => {
      analyzeInterestPatterns();
    }, 2000); // Analyze every 2 seconds
    
    return () => clearInterval(analysisInterval);
  }, [isInterestDetectionEnabled, movementTrail.length]);

  // Trigger when finger lifts/disappears
  useEffect(() => {
    if (!isFingerLongPressLLMEnabled) return;

    if (longPressState.shouldTriggerOnMove !== false && !isProcessing) {
      console.log('[LongPress] Finger lifted/disappeared, trigger OCR at level:', longPressState.shouldTriggerOnMove);
      
      // Mark as triggered
      longPressRef.current.hasTriggered = true;
      
      // Set level and trigger OCR
      setLevel(longPressState.shouldTriggerOnMove);
      onFingerSelection();
      
      // Clear trigger flag
      setLongPressState(prev => ({
        ...prev,
        shouldTriggerOnMove: false
      }));
    }
  }, [isFingerLongPressLLMEnabled, longPressState.shouldTriggerOnMove, isProcessing]);

    // 3) Apple Pencil pressure three levels (with slight debounce)
  useEffect(() => {
    const el = overlayRef.current!;
    let last: Level = "light";
    let lastPressure = 0;
    let maxLevelInSession: Level = "light"; // Highest level in this press session
    let isPressed = false; // Whether currently pressing
    let t: any;
    
    // Downgrade mechanism variables
    let downgradeTimer: any;
    let pendingDowngradeLevel: Level | null = null;
    let stableStartTime = 0;
    
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        // Pause video
        const video = videoRef.current!;
        if (video && !video.paused) {
          video.pause();
          setIsVideoFrozen(true);
          console.log('[Drawing] Video paused, entering drawing mode');
        }
        
        isPressed = true;
        setIsPressed(true); // Update component state
        maxLevelInSession = "light"; // Reset max level
        setCurrentMaxLevel("light"); // Sync state
        
        // Start a new drawing path
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setDrawingPath([{x, y}]);
        setSelectionBounds(null);
        
        // Clear any ongoing downgrade
        clearTimeout(downgradeTimer);
        pendingDowngradeLevel = null;
        stableStartTime = 0;
        console.log('[Pressure] Start new press session');
      }
    };
    
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === "pen" && isPressed) {
        isPressed = false;
        setIsPressed(false); // Update component state
        
        // Clear downgrade timer
        clearTimeout(downgradeTimer);
        pendingDowngradeLevel = null;
        
        // Use highest level from this press session
        setLevel(maxLevelInSession);
        setCurrentMaxLevel("light"); // Reset display state
        console.log('[Pressure] Press ended, using max level:', maxLevelInSession);
        setDebugInfo(`pressure end | final level: ${maxLevelInSession}`);
        
        // Note: selectionBounds is computed in onPointerUp, not here
      }
    };
    
    const onMove = (e: PointerEvent) => {
      const p = e.pressure ?? 0;
      const isPen = e.pointerType === "pen";
      
      // Update pressure and device type state
      setCurrentPressure(p);
      setIsUsingPen(isPen);
      
      if (!isPen) return;
      
      // If pressing, record drawing path
      if (isPressed) {
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setDrawingPath(prev => {
          const newPath = [...prev, {x, y}];
          if (newPath.length % 5 === 0) { // Log every 5 points to avoid noise
            console.log('[Drawing] 璺緞鐐规暟:', newPath.length, '鏈€鏂扮偣:', {x: x.toFixed(1), y: y.toFixed(1)});
          }
          return newPath;
        });
      }
      
      if (!isPressed) return; // Only handle pressure during press
      
      // Apple Pencil gen 1/2 support pressure
      const currentLevel: Level = p < 0.33 ? "light" : p < 0.66 ? "medium" : "hard";
      
      // Upgrade logic: immediately move to higher level
      if (currentLevel === "hard" || (currentLevel === "medium" && maxLevelInSession === "light")) {
        maxLevelInSession = currentLevel;
        setCurrentMaxLevel(currentLevel); // Sync state
        clearTimeout(downgradeTimer); // Clear downgrade timer
        pendingDowngradeLevel = null;
        stableStartTime = 0;
      }
      
      // Downgrade logic: require 0.5s stability before downgrading
      const levelOrder = { "light": 0, "medium": 1, "hard": 2 };
      if (levelOrder[currentLevel] < levelOrder[maxLevelInSession]) {
        // Current pressure level is below max level; start downgrade timer
        
        if (pendingDowngradeLevel !== currentLevel) {
          // Start a new downgrade timer
          pendingDowngradeLevel = currentLevel;
          stableStartTime = Date.now();
          clearTimeout(downgradeTimer);
          
          downgradeTimer = setTimeout(() => {
            // Confirm downgrade after 0.5s
            if (pendingDowngradeLevel === currentLevel && isPressed) {
              maxLevelInSession = currentLevel;
              setCurrentMaxLevel(currentLevel); // Sync state
              console.log('[Pressure] Downgraded after stability:', currentLevel);
              setDebugInfo(`pressure: ${p.toFixed(3)} | downgrade to: ${currentLevel} | current highest: ${maxLevelInSession}`);
            }
          }, 500); // 0.5s stability window
          
          console.log('[Pressure] Start downgrade timer to:', currentLevel);
        }
        
        // Show downgrade countdown
        const elapsed = Date.now() - stableStartTime;
        const remaining = Math.max(0, 500 - elapsed);
        setDebugInfo(`pressure: ${p.toFixed(3)} | current: ${currentLevel} | highest: ${maxLevelInSession} | downgrade countdown: ${(remaining/1000).toFixed(1)}s`);
        
      } else {
        // Pressure increased, cancel downgrade
        if (pendingDowngradeLevel) {
          clearTimeout(downgradeTimer);
          pendingDowngradeLevel = null;
          stableStartTime = 0;
          console.log('[Pressure] Pressure rose, cancel downgrade');
        }
        
        // Normal display
        setDebugInfo(`pressure: ${p.toFixed(3)} | current: ${currentLevel} | highest: ${maxLevelInSession}`);
      }
      
    };
    
    const onLeave = () => {
      setCurrentPressure(0);
      setIsUsingPen(false);
      setDebugInfo('');
      isPressed = false;
      setIsPressed(false); // Update component state
      setCurrentMaxLevel("light"); // Reset display state
    };
    
    el.addEventListener("pointerdown", onDown, { passive: true });
    el.addEventListener("pointerup", onUp, { passive: true });
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerleave", onLeave, { passive: true });
    el.style.touchAction = "none";
    
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [level]);

  // 4) Compute selection area from fingertip position
  const calculateFingerSelectionArea = (fingerPos: {x: number, y: number}) => {
    // Create a selection area above the finger
    const areaWidth = 120;  // Selection area width
    const areaHeight = 80;  // Selection area height
    const offsetY = -50;   // Upward offset to avoid finger occlusion
    
    return {
      left: Math.max(0, fingerPos.x - areaWidth / 2),
      top: Math.max(0, fingerPos.y + offsetY - areaHeight / 2),
      width: areaWidth,
      height: areaHeight
    };
  };

  const requestPressureLlm = useCallback(async (
    prediction: Exclude<PressurePredictionClass, "NoPress">,
    confidences?: Record<PressurePredictionClass, number>
  ) => {
    if (pressureRequestLockRef.current) return;

    const pointer = fingerTipPositionRef.current;
    if (!pointer) {
      setPressureRequestStatus("pressure request: no fingertip");
      return;
    }

    pressureRequestLockRef.current = true;
    const requestLevel: Level = prediction === "Firm" ? "hard" : "light";
    const nearest = nearestWordRef.current;
    const nearestContext = buildNearestWordContext(nearest);
    const basePageText = compactForPrompt(regionRecognizedText, 2400);
    const topicsForPrompt = (
      topRankedTopics.length > 0
        ? topRankedTopics.map((topic) => topic.text)
        : (regionTopics ?? [])
    ).slice(0, 8);

    let focusedText = "";
    let focusedImage = "";
    let contextSource = basePageText ? "page OCR" : "none";

    try {
      setPressureRequestStatus(`pressure request: ${prediction} detected`);
      setAnswer(
        prediction === "Light"
          ? "pressure request: Light -> brief answer"
          : "pressure request: Firm -> detailed answer"
      );
      setFloatingResponse({
        text: "Thinking...",
        position: { x: pointer.x, y: pointer.y - 18 },
      });

      const shouldRunOnDemandOcr =
        pressureLlmContextMode === "ondemand" ||
        (pressureLlmContextMode === "auto" && !basePageText);

      if (shouldRunOnDemandOcr && videoReady && ocrReady && worker) {
        const area = calculateFingerSelectionArea(pointer);
        setSelectionBounds(area);
        const isIPad =
          /iPad|iPhone|iPod/.test(navigator.userAgent) ||
          (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
        const scale = isIPad ? 1.5 : 2;
        const cropCanvas =
          captureWYSIWYGRegionHiRes(area, scale) || captureWYSIWYGRegion(area);

        if (cropCanvas) {
          if (isEnhancementEnabled) {
            const ctx2d = cropCanvas.getContext("2d");
            if (ctx2d) {
              const imageData = ctx2d.getImageData(
                0,
                0,
                cropCanvas.width,
                cropCanvas.height
              );
              const data = imageData.data;
              for (let i = 0; i < data.length; i += 4) {
                const gray =
                  0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                const enhanced = Math.max(
                  0,
                  Math.min(255, 1.5 * (gray - 128) + 128 + 20)
                );
                const bw = enhanced > 128 ? 255 : 0;
                data[i] = bw;
                data[i + 1] = bw;
                data[i + 2] = bw;
              }
              ctx2d.putImageData(imageData, 0, 0);
            }
          }

          focusedImage = cropCanvas.toDataURL("image/png");
          setCapturedImage(focusedImage);
          const {
            data: { text },
          } = await worker.recognize(cropCanvas);
          focusedText = text.trim().slice(0, 700);
          if (focusedText) {
            contextSource = "on-demand OCR";
          }
        }
      }

      const prompt = [
        "You are an AR reading assistant for finger-based paper reading.",
        "NoPress means normal reading and is ignored by the client. This request was intentionally triggered by pressure.",
        prediction === "Light"
          ? "Interaction: Light press. Give a brief, direct answer in 1-2 sentences."
          : "Interaction: Firm press. Give a more detailed answer with the reasoning needed to understand the pointed context.",
        "",
        `Pressure confidence: Firm ${(confidences?.Firm ?? 0).toFixed(2)}, Light ${(confidences?.Light ?? 0).toFixed(2)}, NoPress ${(confidences?.NoPress ?? 0).toFixed(2)}`,
        `Pointer: x=${pointer.x.toFixed(0)}, y=${pointer.y.toFixed(0)}`,
        `Context source: ${contextSource}`,
        nearestContext ? `Nearest-word context:\n${nearestContext}` : "Nearest-word context: unavailable; do not treat this as an error.",
        focusedText ? `On-demand OCR near finger:\n${focusedText}` : "",
        topicsForPrompt.length > 0
          ? `Page topics/ranked focus candidates: ${topicsForPrompt.join(", ")}`
          : "",
        basePageText ? `Full-page OCR context:\n${basePageText}` : "",
        "",
        "If the local OCR is noisy, infer the likely concept from the page context and the pointed position.",
        "If there is no enough context, ask one concise clarification question instead of hallucinating.",
      ].filter(Boolean).join("\n");

      const resp = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text:
            focusedText ||
            nearest?.text ||
            topicsForPrompt[0] ||
            basePageText.slice(0, 400) ||
            "pointed reading context",
          level: requestLevel,
          image: focusedImage || undefined,
          prompt,
          streaming: false,
          language: "en",
        }),
      });

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "");
        throw new Error(errorText || `LLM API error: ${resp.status}`);
      }

      const data = await resp.json();
      const content = data?.content || "No response";
      setAnswer(`pressure ${prediction} request\n\n${content}`);
      setFloatingResponse({
        text: content,
        position: { x: pointer.x, y: pointer.y - 18 },
      });
      setPressureRequestStatus(`pressure request: ${prediction} answered`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[PressureRequest] failed", error);
      setAnswer(`pressure request error: ${message}`);
      setFloatingResponse({
        text: `Error: ${message}`,
        position: { x: pointer.x, y: pointer.y - 18 },
      });
      setPressureRequestStatus(`pressure request failed: ${message}`);
    } finally {
      pressureRequestLockRef.current = false;
    }
  }, [
    buildNearestWordContext,
    calculateFingerSelectionArea,
    captureWYSIWYGRegion,
    captureWYSIWYGRegionHiRes,
    compactForPrompt,
    isEnhancementEnabled,
    ocrReady,
    pressureLlmContextMode,
    regionRecognizedText,
    regionTopics,
    topRankedTopics,
    videoReady,
    worker,
  ]);

  const handlePressureInferenceSnapshot = useCallback((snapshot: {
    prediction: PressurePredictionClass | null;
    confidences: Record<PressurePredictionClass, number>;
    inferMs: number | null;
    status: "idle" | "loading" | "ready" | "error";
  }) => {
    setPressureInferenceClass(snapshot.prediction);

    const prediction = snapshot.prediction;
    if (!prediction || prediction === "NoPress") {
      pressureCandidateRef.current = null;
      pressureInteractionActiveRef.current = false;
      pressureTriggeredClassRef.current = null;
      if (prediction === "NoPress") {
        setPressureRequestStatus("pressure request: normal reading");
      }
      return;
    }

    if (!isPressureLlmEnabledRef.current || snapshot.status !== "ready") {
      return;
    }

    const confidence = snapshot.confidences[prediction] ?? 0;
    const minConfidence = prediction === "Firm" ? 0.58 : 0.52;
    if (confidence < minConfidence) {
      return;
    }

    const now = Date.now();
    const candidate = pressureCandidateRef.current;
    if (!candidate || candidate.prediction !== prediction) {
      pressureCandidateRef.current = { prediction, since: now };
      return;
    }

    const stableMs = prediction === "Firm" ? 450 : 550;
    if (now - candidate.since < stableMs) {
      return;
    }
    const triggeredClass = pressureTriggeredClassRef.current;
    if (triggeredClass === "Firm") {
      return;
    }
    if (triggeredClass === "Light" && prediction === "Light") {
      return;
    }
    const minTriggerGapMs =
      triggeredClass === "Light" && prediction === "Firm" ? 650 : 1800;
    if (now - pressureLastTriggerAtRef.current < minTriggerGapMs) {
      return;
    }

    pressureInteractionActiveRef.current = true;
    pressureTriggeredClassRef.current = prediction;
    pressureLastTriggerAtRef.current = now;
    void requestPressureLlm(prediction, snapshot.confidences);
  }, [requestPressureLlm]);



  // 5) Finger-mode screenshot function (called at light level)
  const takeFingerScreenshot = async (fingerPos: {x: number, y: number}) => {
    if (longPressRef.current.hasScreenshot) {
      return; // Already captured
    }
    
    console.log('[Screenshot] Reached light level, start capture, position:', fingerPos);
    longPressRef.current.hasScreenshot = true;
    
    // Keep video playing in finger mode; otherwise fingertip detection stops
    console.log('[Screenshot] Keep video playing in finger mode for detection');
    
    // Compute selection area
    const selectionArea = calculateFingerSelectionArea(fingerPos);
    setSelectionBounds(selectionArea);
    
    // Only capture now; OCR will be triggered later
    console.log('[Screenshot] Capture done, waiting for OCR trigger');
  };

  // 6) Finger selection handler (OCR uses captured frame)
  const onFingerSelection = async () => {
    if (captureLockRef.current) { console.log('[Finger] capture busy, skip'); return; }
    captureLockRef.current = true;
    if (!selectionBounds || !videoReady || !ocrReady || !worker) {
      console.log('[Finger] 鏉′欢涓嶆弧瓒?', { 
        hasSelectionBounds: !!selectionBounds, 
        videoReady, 
        ocrReady, 
        hasWorker: !!worker 
      });
      return;
    }
    
    if (isProcessing) {
      console.log('[Finger] 宸插湪澶勭悊涓紝璺宠繃');
      return;
    }
    setIsProcessing(true);
    
    console.log('[Finger] 寮€濮婳CR澶勭悊锛屼娇鐢ㄥ凡鎴睆鍖哄煙:', selectionBounds);
    
    setDebugInfo(`finger mode: selection area ${selectionBounds.width}x${selectionBounds.height}px`);
    
    // Use Three.js render for WYSIWYG capture
    try {
      const renderer = threeRendererRef.current;
      const scene = threeSceneRef.current;
      const camera = threeCameraRef.current;
      const renderCanvas = renderer?.domElement;
      if (!renderer || !scene || !camera || !renderCanvas) {
        console.warn('[Finger] Three.js not ready, fallback to legacy capture');
        // Keep legacy path to avoid interruption
        return;
      }
      
      // Crop selected region from Three.js canvas (with DPR)
      // High-res export (scale=2 or 3 optional)
      // Lower scale on iPad-class devices to avoid OOM
      const isIPad = /iPad|iPhone|iPod/.test(navigator.userAgent) || ((/Macintosh/.test(navigator.userAgent)) && (navigator.maxTouchPoints > 1));
      const scale = isIPad ? 1.5 : 2;
      const cropCanvas = captureWYSIWYGRegionHiRes(selectionBounds, scale) || captureWYSIWYGRegion(selectionBounds);
      if (!cropCanvas) {
        console.error('[Finger] WYSIWYG crop failed: canvas was empty');
        setIsProcessing(false);
        return;
      }
      console.log('[Finger] screenshot capture completed (Three.js WYSIWYG)');
      
      // Image enhancement
      if (isEnhancementEnabled) {
        const ctx2d = cropCanvas.getContext('2d')!;
        const imageData = ctx2d.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
          let r = data[i], g = data[i + 1], b = data[i + 2];
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          const contrast = 1.5, brightness = 20;
          let enhanced = contrast * (gray - 128) + 128 + brightness;
          enhanced = Math.max(0, Math.min(255, enhanced));
          const threshold = 128;
          enhanced = enhanced > threshold ? 255 : 0;
          data[i] = data[i + 1] = data[i + 2] = enhanced;
        }
        
        ctx2d.putImageData(imageData, 0, 0);
        console.log('[Finger] 鉁?Image enhancement done');
      }
      
      // Get processed image (WYSIWYG)
      const imageDataUrl = cropCanvas.toDataURL();
      // Defer UI update to avoid blocking main thread
      setTimeout(() => {
        try { setCapturedImage(imageDataUrl); } catch {}
      }, 0);
      
      // OCR recognition
      console.log('[Finger] 寮€濮婳CR璇嗗埆...');
      const { data: { text } } = await worker.recognize(cropCanvas);
      const picked = text.trim().slice(0, 400);
      
      console.log('[Finger] OCR璇嗗埆缁撴灉:', { 
        originalLength: text.length, 
        trimmedLength: picked.length, 
        text: picked 
      });
      
      setAnswer(`finger mode: calling LLM... (level: ${level})\n\nrecognized text: ${picked || "(no text detected)"}`);
      
      if(picked.length === 0) {
        setAnswer("finger mode: no text detected");
        console.log('[Finger] 鏂囨湰涓虹┖');
        return;
      }
      
      // Call LLM
      const resp = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: picked || "No text", level, image: imageDataUrl, streaming: isStreaming }),
      });
      
      if (!resp.ok) {
        throw new Error(`LLM API 閿欒: ${resp.status}`);
      }
      
      if (isStreaming) {
        // Streaming response handling
        const reader = resp.body?.getReader();
        if (!reader) throw new Error('鏃犳硶鑾峰彇娴佸紡鍝嶅簲');
        
        setAnswer("");
        
        // Set floating panel position (beside selection)
        if (selectionBounds) {
          const videoContainer = document.querySelector('.video-container');
          const containerRect = videoContainer?.getBoundingClientRect();
          
          let floatingX, floatingY;
          if (containerRect) {
            floatingX = containerRect.left + selectionBounds.left + selectionBounds.width / 2;
            floatingY = containerRect.top + selectionBounds.top - 10;
          } else {
            floatingX = selectionBounds.left + selectionBounds.width / 2;
            floatingY = selectionBounds.top - 10;
          }
          
          setFloatingResponse({
            text: "",
            position: { x: floatingX, y: floatingY }
          });
        }
        
        const decoder = new TextDecoder();
        let buffer = "";
        let streamingText = "";
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || "";
            
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]' || data === '') continue;
                
                try {
                  const parsed = JSON.parse(data);
                  const content = parsed.choices?.[0]?.delta?.content;
                  if (content) {
                    streamingText += content;
                    setAnswer(prev => prev + content);
                    
                    if (selectionBounds) {
                      setFloatingResponse(prev => prev ? {
                        ...prev,
                        text: streamingText
                      } : null);
                    }
                  }
                } catch (e) {
                  console.log('[Finger Streaming] 璺宠繃鏃犳晥琛?', line);
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        // Non-streaming response
        const data = await resp.json();
        const content = data.content || "No response";
        
        console.log('[Finger] LLM鍝嶅簲瀹屾垚:', { contentLength: content.length });
        setAnswer(`finger mode: result\n\n${content}`);
        
        // Set floating panel
        if (selectionBounds) {
          const videoContainer = document.querySelector('.video-container');
          const containerRect = videoContainer?.getBoundingClientRect();
          
          let floatingX, floatingY;
          if (containerRect) {
            floatingX = containerRect.left + selectionBounds.left + selectionBounds.width / 2;
            floatingY = containerRect.top + selectionBounds.top - 10;
          } else {
            floatingX = selectionBounds.left + selectionBounds.width / 2;
            floatingY = selectionBounds.top - 10;
          }
          
          setFloatingResponse({
            text: content,
            position: { x: floatingX, y: floatingY }
          });
        }
      }
      
    } catch (err: any) {
      console.error('[Finger] 澶勭悊澶辫触:', err);
      setAnswer(`finger mode: error: ${err?.message || String(err)}`);
    } finally {
      setIsProcessing(false);
      captureLockRef.current = false;
    }
  };

  // 6) Tap (PointerUp is more stable) 鈫?crop ROI 鈫?OCR 鈫?LLM
  const onPointerUp = async (e: React.PointerEvent<HTMLElement>) => {
    console.log('[Click] 妫€娴嬪埌鐐瑰嚮浜嬩欢:', {
      pointerType: e.pointerType,
      pressure: e.pressure,
      clientX: e.clientX,
      clientY: e.clientY,
      videoReady,
      ocrReady,
      hasWorker: !!worker,
      drawingPathLength: drawingPath.length
    });
    
    // Prevent duplicate processing
    if (isProcessing) {
      console.log('[OCR] 宸插湪澶勭悊涓紝璺宠繃');
      return;
    }
    setIsProcessing(true);

    // First compute drawing bounds
    let calculatedBounds = null;
    if (drawingPath.length >= 1) {
      let bounds;
      
      // Compute total stroke travel distance
      let totalDistance = 0;
      for (let i = 1; i < drawingPath.length; i++) {
        const dx = drawingPath[i].x - drawingPath[i-1].x;
        const dy = drawingPath[i].y - drawingPath[i-1].y;
        totalDistance += Math.sqrt(dx * dx + dy * dy);
      }
      
      console.log('[Drawing] 绗旇抗鍒嗘瀽:', {
        pointCount: drawingPath.length,
        totalDistance: totalDistance.toFixed(1),
        isShortMovement: totalDistance < 30
      });
      
      if (totalDistance < 30) {
        // If movement < 30px, treat as a tap
        const point = drawingPath[0];
        const defaultSize = 150; // Default region size
        bounds = {
          left: Math.max(0, point.x - defaultSize/2),
          top: Math.max(0, point.y - defaultSize/2),
          width: defaultSize,
          height: defaultSize
        };
        console.log('[Drawing] 鍗曠偣鐐瑰嚮 (璺濈<30px)锛屼娇鐢ㄩ粯璁ゅ尯鍩?', bounds);
      } else {
        // Larger movement indicates real drawing
        const xs = drawingPath.map(p => p.x);
        const ys = drawingPath.map(p => p.y);
        const margin = 1; // Margin
        bounds = {
          left: Math.max(0, Math.min(...xs) - margin),
          top: Math.max(0, Math.min(...ys) - margin),
          width: Math.max(...xs) - Math.min(...xs) + margin * 2,
          height: Math.max(...ys) - Math.min(...ys) + margin * 2
        };
        console.log('[Drawing] 鐪熷疄缁樺埗 (璺濈鈮?0px)锛岃绠楄竟鐣?', bounds, '鎬昏窛绂?', totalDistance.toFixed(1));
      }
      
      calculatedBounds = bounds;
      setSelectionBounds(bounds);
      console.log('[Drawing] 鉁?Selection region set:', bounds);
    } else {
      console.log('[Drawing] 鈿狅笍 No drawing path, clear selection region');
      setSelectionBounds(null);
    }
    
    setDebugInfo(`Click detected: ${e.pointerType} pressure:${e.pressure?.toFixed(2) || 'N/A'}`);
    
    // Don't pause video; crop directly from Three.js render canvas
    
    // Update current pressure display
    setCurrentPressure(e.pressure || 0);
    setIsUsingPen(e.pointerType === "pen");
    
    if (!videoReady) { 
      setAnswer("Video is not ready, please wait..."); 
      console.log('[Click] video not ready');
      return; 
    }
    if (!ocrReady || !worker) { 
      setAnswer("OCR engine is still loading, please wait..."); 
      console.log('[Click] OCR not ready');
      return; 
    }

    if (!videoReady || !ocrReady || !worker) {
      console.log('[OCR] 鏈噯澶囧氨缁?', { videoReady, ocrReady, hasWorker: !!worker });
      return;
    } 

    const v = videoRef.current;
    const overlay = overlayRef.current;
    if (!v || !overlay) {
      console.log('[OCR] 鍏冪礌寮曠敤缂哄け');
      return;
    }
    
    // Capture directly from overlay to avoid complex coord transforms
    console.log('[OCR] 浣跨敤overlay鐩存帴鎴浘鏂规硶');
    
    if (!calculatedBounds || calculatedBounds.width <= 5 || calculatedBounds.height <= 5) {
      setAnswer("please use Apple Pencil to draw the area to be recognized");
      setIsProcessing(false);
      return;
    }
    
    // Create canvas for capture
    const canvas = document.createElement("canvas");
    canvas.width = calculatedBounds.width;
    canvas.height = calculatedBounds.height;
    const ctx = canvas.getContext("2d")!;
    
    // Image enhancement function
    const enhanceImage = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
      console.log('[Enhancement] start image enhancement processing...');
      
      // Get image data
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      // Enhance contrast and brightness
      for (let i = 0; i < data.length; i += 4) {
        // RGB values
        let r = data[i];
        let g = data[i + 1];
        let b = data[i + 2];
        
        // Convert to grayscale (better for text recognition)
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        
        // Enhance contrast (sharper text)
        const contrast = 1.5; // Contrast gain
        const brightness = 20; // Brightness adjustment
        
        let enhanced = contrast * (gray - 128) + 128 + brightness;
        enhanced = Math.max(0, Math.min(255, enhanced));
        
        // Apply binarization (helps OCR)
        const threshold = 128;
        enhanced = enhanced > threshold ? 255 : 0;
        
        // Set enhanced values
        data[i] = enhanced;     // R
        data[i + 1] = enhanced; // G  
        data[i + 2] = enhanced; // B
        // Keep alpha channel unchanged
      }
      
      // Write processed data back to canvas
      ctx.putImageData(imageData, 0, 0);
      console.log('[Enhancement] image enhancement completed');
    };
    
    console.log('[Click] 寮€濮嬩粠overlay鐩存帴鎴浘...', {
      canvasSize: { width: canvas.width, height: canvas.height },
      selectionBounds: calculatedBounds
    });

    try {
      // Method: use getDisplayMedia or DOM snapshot
      // Easiest: draw overlay to a temp canvas, then crop
      
      console.log('[Screenshot] 寮€濮嬫埅鍙杘verlay鍖哄煙...');
      
      // Collect size info for debugging
      const overlayRect = overlay.getBoundingClientRect();
      const videoRect = v.getBoundingClientRect();
      const videoNaturalSize = { width: v.videoWidth, height: v.videoHeight };
      const containerSize = { width: 500, height: 500 }; // Configured container size
      
      console.log('[Debug] bounds comparison:', {
        selectionBounds: calculatedBounds,
        overlaySize: { width: overlayRect.width, height: overlayRect.height },
        videoDisplaySize: { width: videoRect.width, height: videoRect.height },
        videoNaturalSize,
        containerSize,
        currentTransform: { scale: videoScale, translate: videoTranslate },
      });
      
      // Create temp canvas to draw full overlay
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = overlayRect.width;
      tempCanvas.height = overlayRect.height;
      const tempCtx = tempCanvas.getContext("2d")!;
      
      console.log('[Debug] 涓存椂Canvas灏哄:', { width: tempCanvas.width, height: tempCanvas.height });
      
      // Draw video into temp canvas (with all transforms)
      tempCtx.save();
      
      console.log('[Debug] 寮€濮嬪簲鐢ㄥ彉鎹?..');
      
      // Apply same transforms as video
      tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
      console.log('[Debug] 1. 绉诲姩鍒颁腑蹇?', tempCanvas.width / 2, tempCanvas.height / 2);
      
      tempCtx.scale(-1, 1); // Horizontal flip
      console.log('[Debug] 2. 姘村钩缈昏浆');
      
      tempCtx.scale(videoScale, videoScale); // Scale
      console.log('[Debug] 3. 缂╂斁:', videoScale);
      
      tempCtx.translate(videoTranslate.x, videoTranslate.y); // Translate
      console.log('[Debug] 4. 骞崇Щ:', videoTranslate.x, videoTranslate.y);
      
      tempCtx.translate(-tempCanvas.width / 2, -tempCanvas.height / 2);
      console.log('[Debug] 5. 绉诲洖鍘熺偣');
      console.log('[Debug] 娉ㄦ剰锛氭埅鍥句笉鍖呭惈閫忚鍙樻崲锛圕anvas 2D闄愬埗锛夛紝閫忚寮哄害:', perspectiveStrength);
      console.log('[Debug] coordinate system alignment updated');
      
      // Draw video preserving aspect ratio
      // Potential issue: should draw native size instead of stretching to canvas
      const videoAspect = v.videoWidth / v.videoHeight;
      const canvasAspect = tempCanvas.width / tempCanvas.height;
      
      let drawWidth, drawHeight, drawX, drawY;
      
      if (videoAspect > canvasAspect) {
        // Video is wider; use width
        drawWidth = tempCanvas.width;
        drawHeight = tempCanvas.width / videoAspect;
        drawX = 0;
        drawY = (tempCanvas.height - drawHeight) / 2;
      } else {
        // Video is taller; use height
        drawHeight = tempCanvas.height;
        drawWidth = tempCanvas.height * videoAspect;
        drawX = (tempCanvas.width - drawWidth) / 2;
        drawY = 0;
      }
      
      console.log('[Debug] 缁樺埗鍙傛暟:', {
        videoAspect,
        canvasAspect,
        drawArea: { x: drawX, y: drawY, width: drawWidth, height: drawHeight }
      });
      
      tempCtx.drawImage(v, drawX, drawY, drawWidth, drawHeight);
      tempCtx.restore();
      
      // Extract selection from temp canvas
      console.log('[Debug] preparing extraction region:', {
        extractedBounds: calculatedBounds,
        tempCanvasSize: { width: tempCanvas.width, height: tempCanvas.height },
        finalCanvasSize: { width: canvas.width, height: canvas.height },
      });
      
      // Check extraction region bounds
      const safeLeft = Math.max(0, Math.min(calculatedBounds.left, tempCanvas.width - 1));
      const safeTop = Math.max(0, Math.min(calculatedBounds.top, tempCanvas.height - 1));
      const safeWidth = Math.min(calculatedBounds.width, tempCanvas.width - safeLeft);
      const safeHeight = Math.min(calculatedBounds.height, tempCanvas.height - safeTop);
      
      console.log('[Debug] safe bounds check:', {
        original: calculatedBounds,
        safe: { left: safeLeft, top: safeTop, width: safeWidth, height: safeHeight },
      });
      
      const selectionImageData = tempCtx.getImageData(
        safeLeft, 
        safeTop, 
        safeWidth, 
        safeHeight
      );
      
      console.log('[Debug] 鎻愬彇鐨処mageData:', {
        width: selectionImageData.width,
        height: selectionImageData.height,
        dataLength: selectionImageData.data.length
      });
      
      // Draw extracted region onto final canvas
      ctx.putImageData(selectionImageData, 0, 0);
      
      console.log('[Screenshot] 浠巓verlay鎴浘瀹屾垚');
      
      // Extra debug: save temp canvas for inspection
      const tempDataURL = tempCanvas.toDataURL();
      console.log('[Debug] 涓存椂Canvas鍐呭闀垮害:', tempDataURL.length);
      console.log('[Debug] 浣犲彲浠ュ湪娴忚鍣ㄦ帶鍒跺彴澶嶅埗杩欎釜URL鏌ョ湅涓存椂canvas鍐呭:');
      console.log(tempDataURL.substring(0, 100) + '...');
      
      // Verify canvas has content
      const imageData = ctx.getImageData(0, 0, Math.min(10, canvas.width), Math.min(10, canvas.height));
      const hasContent = imageData.data.some(pixel => pixel !== 0);
      console.log('[Click] Canvas鍐呭妫€鏌?', { 
        hasContent,
        samplePixels: Array.from(imageData.data.slice(0, 12))
      });
      
      if (!hasContent) {
        console.error('[Click] Canvas鍐呭涓虹┖锛佸皾璇昳Pad澶囩敤鎹曡幏鏂规硶...');
        
        // iPad fallback: try different draw parameters
        try {
          // Method 1: ensure video fully loaded
          if (v.readyState < 2) {
            setAnswer("Error: Video not fully loaded, please wait for video to be ready");
            setCapturedImage("");
            return;
          }
          
          // Method 2: draw full video then crop
          const tempCanvas = document.createElement("canvas");
          tempCanvas.width = v.videoWidth;
          tempCanvas.height = v.videoHeight;
          const tempCtx = tempCanvas.getContext("2d")!;
          
          // Draw full video frame
          tempCtx.drawImage(v, 0, 0);
          
          // Check full video frame has content
          const fullImageData = tempCtx.getImageData(0, 0, Math.min(10, v.videoWidth), Math.min(10, v.videoHeight));
          const fullHasContent = fullImageData.data.some(pixel => pixel !== 0);
          
          if (!fullHasContent) {
            setAnswer("Error: No pixel data from video on iPad, possibly Safari security restrictions");
            setCapturedImage("");
            return;
          }
          
          // Extract ROI from full video frame
          const roiImageData = tempCtx.getImageData(
            calculatedBounds.left, calculatedBounds.top, 
            calculatedBounds.width, calculatedBounds.height
          );
          ctx.putImageData(roiImageData, 0, 0);
          
          console.log('[Click] iPad澶囩敤鎹曡幏鎴愬姛');
          
        } catch (fallbackError: any) {
          console.error('[Click] iPad澶囩敤鎹曡幏涔熷け璐?', fallbackError);
          setAnswer(`Error: All video capture methods failed - ${fallbackError.message || String(fallbackError)}`);
          setCapturedImage("");
          return;
        }
      }
      
    } catch (drawError: any) {
      console.error('[Click] 缁樺埗瑙嗛甯у埌canvas鏃跺嚭閿?', drawError);
      setAnswer(`Error: Failed to draw video frame to canvas - ${drawError.message || String(drawError)}`);
      setCapturedImage("");
      return;
    }

    console.log('[Click] Canvas 鍒涘缓瀹屾垚锛屽紑濮?OCR...', {
      canvasSize: { width: canvas.width, height: canvas.height },
      selectionBounds: calculatedBounds,
      videoSize: { width: v.videoWidth, height: v.videoHeight }
    });

    // WYSIWYG: crop from Three.js render canvas
    const region = calculatedBounds || selectionBounds;
    const isIPad = /iPad|iPhone|iPod/.test(navigator.userAgent) || ((/Macintosh/.test(navigator.userAgent)) && (navigator.maxTouchPoints > 1));
    const scale = isIPad ? 1.5 : 2;
    const cropSource = region ? (captureWYSIWYGRegionHiRes(region, scale) || captureWYSIWYGRegion(region)) : null;
    if (!cropSource) {
      setAnswer('Three.js renderer not ready');
      setIsProcessing(false);
      return;
    }
    let imageDataUrl;
    try {
      imageDataUrl = cropSource.toDataURL();
      console.log('[Click] WYSIWYG鎴浘鎴愬姛锛岄暱搴?', imageDataUrl.length);
    } catch (e: any) {
      console.error('[Click] DataURL澶辫触:', e);
      setIsProcessing(false);
      return;
    }
    
    // Apply image enhancement depending on settings
    if (isEnhancementEnabled) {
      const ctx = cropSource.getContext('2d')!;
      enhanceImage(cropSource, ctx);
      console.log('[Enhancement] image enhancement enabled');
    } else {
      console.log('[Enhancement] image enhancement disabled');
    }
    
    // Get processed image for display
    setTimeout(() => {
      try { setCapturedImage(imageDataUrl); } catch {}
    }, 0);
    
    console.log('[Enhancement] 鍥惧儚澧炲己瀹屾垚锛屽紑濮婳CR璇嗗埆...');

    try {
      const { data: { text } } = await worker.recognize(cropSource);
      const picked = text.trim().slice(0, 400);
      console.log('[OCR] 璇嗗埆缁撴灉:', { 
        originalLength: text.length, 
        trimmedLength: picked.length, 
        text: picked 
      });
      
      setAnswer(`calling LLM... (pressure level: ${level})\n\nrecognized text: ${picked || "(no text detected)"}`);
      setDebugInfo(`pressure level: ${level})\n\nrecognized text: ${picked || "(no text detected)"}`);
      if(picked.length === 0) {
        setAnswer("no text detected");
        console.log('[OCR] recognized text was empty; image quality or region may be the cause');
        return;
      }

      // Call LLM
      const resp = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: picked || "No text", level, image: imageDataUrl, streaming: isStreaming }),
      });

      console.log('[LLM] API 璋冪敤鐘舵€?', resp.status);

      if (!resp.ok) {
        throw new Error(`LLM API 閿欒: ${resp.status}`);
      }

      if (isStreaming) {
        // Handle streaming response
        const reader = resp.body?.getReader();
        if (!reader) {
          throw new Error('鏃犳硶鑾峰彇娴佸紡鍝嶅簲');
        }

        setAnswer(""); // Clear previous answer
        
        // Initialize floating panel position
        if (calculatedBounds) {
          const containerWidth = 500;
          const floatingWidth = 240;
          
          let floatingX, floatingY;
          
          // Get video container position on page
          const videoContainer = document.querySelector('.video-container');
          const containerRect = videoContainer?.getBoundingClientRect();
          
          if (containerRect) {
            floatingX = containerRect.left + calculatedBounds.left + calculatedBounds.width / 2;
            floatingY = containerRect.top + calculatedBounds.top - 10;
          } else {
            floatingX = calculatedBounds.left + calculatedBounds.width / 2;
            floatingY = calculatedBounds.top - 10;
          }
          
          setFloatingResponse({
            text: "",
            position: { x: floatingX, y: floatingY }
          });
        }
        
        const decoder = new TextDecoder();
        
        try {
          let buffer = "";
          let streamingText = "";
          
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            
            // Keep the last incomplete line in buffer
            buffer = lines.pop() || "";
            
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                if (data === '') continue;
                
                try {
                  const parsed = JSON.parse(data);
                  const content = parsed.choices?.[0]?.delta?.content;
                  if (content) {
                    streamingText += content;
                    setAnswer(prev => prev + content);
                    
                    // Update floating panel content
                    if (calculatedBounds) {
                      setFloatingResponse(prev => prev ? {
                        ...prev,
                        text: streamingText
                      } : null);
                    }
                  }
                } catch (e) {
                  console.log('[Streaming] 璺宠繃鏃犳晥琛?', line);
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        // Handle non-streaming response
        const data = await resp.json();
        const content = data.content || "No response";
        
        console.log('[LLM] 鍝嶅簲瀹屾垚:', { contentLength: content.length });
        setAnswer(content);
        
        // Set floating panel position (beside selection)
        if (calculatedBounds) {
          const containerWidth = 500; // Video container width
          const floatingWidth = 240; // Approx floating width
          
          // Smart position: above selection box
          let floatingX, floatingY;
          
          // Get video container position on page
          const videoContainer = document.querySelector('.video-container');
          const containerRect = videoContainer?.getBoundingClientRect();
          
          if (containerRect) {
            // X coordinate: absolute page position
            floatingX = containerRect.left + calculatedBounds.left + calculatedBounds.width / 2;
            
            // Y coordinate: absolute page position, above selection
            floatingY = containerRect.top + calculatedBounds.top - 10;
          } else {
            // Fallback
            floatingX = calculatedBounds.left + calculatedBounds.width / 2;
            floatingY = calculatedBounds.top - 10;
          }
          
          setFloatingResponse({
            text: content,
            position: { x: floatingX, y: floatingY }
          });
        }
      }
    } catch (err:any) {
      console.error(err);
      setAnswer("Error: " + (err?.message || String(err)));
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <main className="min-h-screen bg-white p-4">
   
      <h1 className="text-xl font-semibold mb-3 text-gray-600">PressureLens - Web</h1>

      <div className="mb-2 text-sm text-gray-600">
        Video: {videoReady ? "ready" : "loading"} |
        OCR: {ocrReady ? "ready" : "loading"} |
        Level: <b className={
          level==="light" ? "text-green-600" :
          level==="medium" ? "text-amber-600" : "text-red-600"
        }>{level}</b>
        {isUsingPen && currentPressure > 0 && (
          <span className="ml-2 text-blue-600">
            Apple Pencil pressure: <b>{currentPressure.toFixed(3)}{drawingPath.length}</b>
          </span>
        )}
        {debugInfo && <div className="mt-1 text-xs text-blue-600">[Debug] {debugInfo}</div>}
        {/* {deviceInfo && <div className="mt-1 text-xs text-purple-600">馃摫 {deviceInfo}</div>} */}
        <button
          onClick={() => sessionLogger.exportJson(deviceInfo)}
          className="ml-auto px-3 py-1 rounded text-xs bg-black text-white hover:bg-gray-900"
        >
          download session package
        </button>
        <a
          href="/register-pressure"
          className="ml-2 px-3 py-1 rounded text-xs border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          register pressure model
        </a>
      </div>

      {/* Data logging toggle & basic stats */}
      <div className="mb-3 flex flex-wrap gap-3 items-center text-sm">
        <div className="flex items-center gap-2">
          <span className="text-gray-600">data logging:</span>
          <button
            onClick={() => setIsLoggingEnabled((v) => !v)}
            className={`px-3 py-1 rounded text-sm transition-colors ${
              isLoggingEnabled ? "bg-emerald-500 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            {isLoggingEnabled ? "on" : "off"}
          </button>
        </div>
        <div className="text-xs text-gray-600">
          {(() => {
            const s = sessionLogger.getSummary();
            return (
              <>
                samples: <span className="font-semibold">{s.pointerSamples}</span> |
                voice: <span className="font-semibold ml-1">{s.voiceAnnotations}</span> |
                selected topics: <span className="font-semibold ml-1">{s.selectedTopics}</span> |
                page topics: <span className="font-semibold ml-1">{s.hasPageOcr ? "yes" : "no"}</span>
              </>
            );
          })()}
        </div>
      
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-600">pressure model user:</span>
        <input
          value={pressureModelUserId}
          onChange={(event) => setPressureModelUserId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void applyPressureModelUser();
            }
          }}
          placeholder="user_id"
          className="px-2 py-1 rounded border border-gray-300 text-sm"
        />
        <button
          type="button"
          onClick={() => void applyPressureModelUser()}
          className="px-3 py-1 rounded text-xs bg-emerald-600 text-white hover:bg-emerald-700"
        >
          load user model
        </button>
        <button
          type="button"
          onClick={() => {
            setPressureModelUserId("");
            window.localStorage.removeItem(PRESSURE_MODEL_USER_STORAGE_KEY);
            window.dispatchEvent(new Event(PRESSURE_MODEL_UPDATED_EVENT));
            setPressureModelMessage("pressure model: final13 base");
          }}
          className="px-3 py-1 rounded text-xs border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          base model
        </button>
        <span className="text-xs text-gray-500">{pressureModelMessage}</span>
      </div>

      

      {/* Pressure bar */}
      {(
        <div className="mb-3 p-2 bg-gray-100 rounded-lg">
          <div className="text-xs text-gray-600 mb-1">pressure bar</div>
          <div className="relative w-full h-6 bg-gray-200 rounded-full overflow-hidden">
            <div 
              className={`h-full ${
                currentMaxLevel === 'light' ? 'bg-green-500' :
                currentMaxLevel === 'medium' ? 'bg-amber-500' : 'bg-red-500'
              }`}
              style={{ 
                width: `${isPressed ? Math.min(100, currentPressure * 100) : 0}%`,
                transition: 'none' // Remove transition for realtime response
              }}
            />
            <div className="absolute inset-0 flex items-center justify-center text-xs font-medium text-white mix-blend-difference">
              {isPressed ? (currentPressure * 100).toFixed(0) : 0}%
            </div>
            {/* Pressure level separators */}
            <div className="absolute top-0 left-1/3 w-px h-full bg-white opacity-50" />
            <div className="absolute top-0 left-2/3 w-px h-full bg-white opacity-50" />
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>light (0-33%)</span>
            <span>medium (33-66%)</span>
            <span>hard (66-100%)</span>
          </div>
        </div>
      )}

      {/* Mode switch */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">input mode:</span>
        <button
          onClick={() => {
            setHandDetectionMode('pencil');
            setIsHandDetectionEnabled(false);
            setFingerTipPosition(null);
            setFingerTipUv(null);
            // setDebugInfo('Switched to Apple Pencil mode');
          }}
          className={`px-3 py-1 rounded text-sm transition-colors ${
            handDetectionMode === 'pencil'
              ? 'bg-blue-500 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
           Apple Pencil 
        </button>
        <button
          onClick={() => {
            setHandDetectionMode('finger');
            setIsHandDetectionEnabled(true);
            setDrawingPath([]);
            setSelectionBounds(null);
            // setDebugInfo('Switched to finger mode, point at text');
          }}
          className={`px-3 py-1 rounded text-sm transition-colors ${
            handDetectionMode === 'finger'
              ? 'bg-green-500 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          finger
        </button>
      </div>

      {/* Interest detection controls */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">intention detection:</span>
        <button
          onClick={() => {
            setIsInterestDetectionEnabled(!isInterestDetectionEnabled);
            if (!isInterestDetectionEnabled) {
              setMovementTrail([]);
              setInterestHeatmap(new Map());
              setCurrentInterestScore(0);
              setInterestAnalysis(null);
            }
          }}
          className={`px-3 py-1 rounded text-sm transition-colors ${
            isInterestDetectionEnabled
              ? 'bg-purple-500 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          {isInterestDetectionEnabled ? 'enabled' : 'disabled'}
        </button>
        {isInterestDetectionEnabled && (
          <div className="text-xs text-purple-600 ml-2">
            realtime speed: {stableRealtimeSpeedPxPerSec.toFixed(1)} px/s
          </div>
        )}
        {/* {isInterestDetectionEnabled && (
          <div className="text-xs text-purple-600 ml-2">
            褰撳墠鍏磋叮搴? {currentInterestScore.toFixed(1)}%
          </div>
        )} */}
      </div>

      {/* Finger long-press LLM toggle */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">finger long-press LLM:</span>
        <button
          onClick={() => setIsFingerLongPressLLMEnabled((v) => !v)}
          className={`px-3 py-1 rounded text-sm transition-colors ${
            isFingerLongPressLLMEnabled
              ? "bg-red-500 text-white"
              : "bg-gray-200 text-gray-700 hover:bg-gray-300"
          }`}
        >
          {isFingerLongPressLLMEnabled ? "enabled" : "disabled"}
        </button>
        <span className="text-xs text-gray-500">
          {isFingerLongPressLLMEnabled
            ? "finger hold will auto OCR + LLM"
            : "no auto OCR/LLM on finger hold"}
        </span>
      </div>

      <div className="mb-3 flex flex-wrap gap-2 items-center">
        <span className="text-sm text-gray-600">pressure request LLM:</span>
        <button
          onClick={() => setIsPressureLlmEnabled((v) => !v)}
          className={`px-3 py-1 rounded text-sm transition-colors ${
            isPressureLlmEnabled
              ? "bg-emerald-600 text-white"
              : "bg-gray-200 text-gray-700 hover:bg-gray-300"
          }`}
        >
          {isPressureLlmEnabled ? "enabled" : "disabled"}
        </button>
        {(["auto", "page", "ondemand"] as PressureLlmContextMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setPressureLlmContextMode(mode)}
            className={`px-2 py-1 rounded text-xs border ${
              pressureLlmContextMode === mode
                ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {mode}
          </button>
        ))}
        <span className="text-xs text-gray-500">
          {pressureInferenceClass ?? "No Hand"} · {pressureRequestStatus}
        </span>
      </div>



      {/* Finger detection status */}
      {/* {handDetectionMode === 'finger' && (
        <div className="mb-3 p-3 bg-green-50 rounded-lg border border-green-200">
          <div className="text-sm text-green-700 mb-2">
            馃摲 闀挎寜妯″紡: {fingerTipPosition ? '鉁?妫€娴嬪埌鎵嬫寚' : '鈴?瀵绘壘鎵嬫寚涓?..'}
            {fingerTipPosition && (
              <span className="ml-2">
               浣嶇疆: ({fingerTipPosition.x.toFixed(0)}, {fingerTipPosition.y.toFixed(0)})
              </span>
            )}
          </div>
          <div className="text-xs text-gray-600 mb-2">
            馃挕 灏嗘墜鎸囨寚鍚戠焊闈㈡枃瀛楀苟淇濇寔涓嶅姩锛岀郴缁熶細鏍规嵁鍋滅暀鏃堕棿鑷姩閫夋嫨璇︾粏绋嬪害锛?            <br/>鈥?0.8-2.0绉? Light绾у埆 (绠€鍗曞洖绛?
            <br/>鈥?2.0-3.5绉? Medium绾у埆 (姝ｅ父璇︾粏搴? 
            <br/>鈥?3.5绉掍互涓? Hard绾у埆 (璇︾粏鍒嗘瀽+寤鸿)
          </div>
          
          {longPressState.isActive && (
            <div className="mt-2 p-2 bg-white rounded border">
              <div className="text-xs text-gray-700">
                馃攧 闀挎寜杩涜涓? <span className="font-bold text-blue-600">{longPressState.currentLevel}</span> 绾у埆
                <span className="ml-2">({(longPressState.currentDuration / 1000).toFixed(1)}绉?</span>
                {longPressRef.current.hasTriggered && <span className="ml-2 text-green-600">鉁?宸茶Е鍙?/span>}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {longPressState.currentLevel === 'hard' && !longPressRef.current.hasTriggered ? 
                  '鈿?鍗冲皢鑷姩瑙﹀彂OCR...' :
                  longPressState.currentDuration >= longPressConfig.autoTriggerDelay ?
                  '馃憜 绉诲紑鎵嬫寚纭褰撳墠绾у埆' : '鈴?缁х画鎸変綇鎻愬崌绾у埆'
                }
              </div>
            </div>
          )}
          
    
          
         
          <div className="mt-3 p-2 bg-gray-50 rounded border">

            
            <div className="grid grid-cols-1 gap-2 text-xs">
              <div className="flex items-center gap-2">
                <label className="w-20 text-gray-600">detection threshold:</label>
                <input
                  type="range"
                  min="0.1"
                  max="1.0"
                  step="0.1"
                  value={handDetectionConfig.minDetectionConfidence}
                  onChange={(e) => {
                    const newConfig = {
                      ...handDetectionConfig,
                      minDetectionConfidence: parseFloat(e.target.value)
                    };
                    setHandDetectionConfig(newConfig);
                    
                    // If instance exists, update config immediately
                    if (handsInstance) {
                      handsInstance.setOptions({
                        maxNumHands: 1,
                        modelComplexity: newConfig.modelComplexity,
                        minDetectionConfidence: newConfig.minDetectionConfidence,
                        minTrackingConfidence: newConfig.minTrackingConfidence,
                        selfieMode: false,
                        staticImageMode: false
                      });
                    }
                  }}
                  className="flex-1 h-1"
                />
                <span className="w-8 text-right">{handDetectionConfig.minDetectionConfidence.toFixed(1)}</span>
              </div>
              
              <div className="flex items-center gap-2">
                <label className="w-20 text-gray-600">tracking threshold:</label>
                <input
                  type="range"
                  min="0.1"
                  max="1.0"
                  step="0.1"
                  value={handDetectionConfig.minTrackingConfidence}
                  onChange={(e) => {
                    const newConfig = {
                      ...handDetectionConfig,
                      minTrackingConfidence: parseFloat(e.target.value)
                    };
                    setHandDetectionConfig(newConfig);
                    
                    if (handsInstance) {
                      handsInstance.setOptions({
                        maxNumHands: 1,
                        modelComplexity: newConfig.modelComplexity,
                        minDetectionConfidence: newConfig.minDetectionConfidence,
                        minTrackingConfidence: newConfig.minTrackingConfidence,
                        selfieMode: false,
                        staticImageMode: false
                      });
                    }
                  }}
                  className="flex-1 h-1"
                />
                <span className="w-8 text-right">{handDetectionConfig.minTrackingConfidence.toFixed(1)}</span>
              </div>
              
              <div className="flex items-center gap-2">
                <label className="w-20 text-gray-600">model complexity:</label>
                <select
                  value={handDetectionConfig.modelComplexity}
                  onChange={(e) => {
                    const newConfig = {
                      ...handDetectionConfig,
                      modelComplexity: parseInt(e.target.value)
                    };
                    setHandDetectionConfig(newConfig);
                    
                    if (handsInstance) {
                      handsInstance.setOptions({
                        maxNumHands: 1,
                        modelComplexity: newConfig.modelComplexity,
                        minDetectionConfidence: newConfig.minDetectionConfidence,
                        minTrackingConfidence: newConfig.minTrackingConfidence,
                        selfieMode: false,
                        staticImageMode: false
                      });
                    }
                  }}
                  className="flex-1 px-2 py-1 border rounded text-xs"
                >
                  <option value={0}>fast (0)</option>
                  <option value={1}>accurate (1)</option>
                </select>
              </div>
            </div>
            
     
          </div>
        </div>
      )} */}

      {/* Apple Pencil gen1 manual level switch */}
      <div className="mb-3 flex gap-2">
        <span className="text-sm text-gray-600">pressure level:</span>
        {(['light', 'medium', 'hard'] as Level[]).map((l) => {
          // If pressing, show currentMaxLevel; otherwise show configured level
          const isActive = isPressed ? (currentMaxLevel === l) : (level === l);
          
          return (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                isActive
                  ? l === 'light' ? 'bg-green-500 text-white' 
                    : l === 'medium' ? 'bg-amber-500 text-white'
                    : 'bg-red-500 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              } ${isPressed ? 'ring-2 ring-blue-300' : ''}`}
            >
              {l === 'light' ? 'light (one sentence)' : l === 'medium' ? 'medium (normal)' : 'hard (detailed + suggestions)'}
            </button>
          );
        })}
      </div>

      {/* Streaming response toggle */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">response mode:</span>
        <button
          onClick={() => setIsStreaming(!isStreaming)}
          className={`px-3 py-1 rounded text-sm transition-colors ${
            isStreaming
              ? 'bg-blue-500 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          {isStreaming ? 'streaming' : 'instant'}
        </button>
      </div>

      {/* Image enhancement toggle */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">image enhancement:</span>
        <button
          onClick={() => setIsEnhancementEnabled(!isEnhancementEnabled)}
          className={`px-3 py-1 rounded text-sm transition-colors ${
            isEnhancementEnabled
              ? 'bg-orange-500 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          {isEnhancementEnabled ? 'enhanced' : 'original'}
        </button>
        <span className="text-xs text-gray-500">
          {isEnhancementEnabled ? '(contrast + grayscale + binarization)' : '(raw camera image)'}
        </span>
      </div>
      {/* Line spacing compensation (three levels) */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">warp:</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">0</span>
          {(() => {
            const opts = [0, 0.18, 0.50];
            const currentIndex = (() => {
              let idx = 0, best = Infinity;
              for (let i = 0; i < opts.length; i++) {
                const d = Math.abs(opts[i] - warpCompensation);
                if (d < best) { best = d; idx = i; }
              }
              return idx;
            })();
            return (
              <input
                type="range"
                min="0"
                max="2"
                step="1"
                value={currentIndex}
                onChange={(e) => {
                  const i = parseInt(e.target.value);
                  const val = opts[i];
                  setWarpCompensation(val);
                  // setDebugInfo(`馃敡 warp: ${i===0?'0':i===1?'0.18':'0.5'} (${val.toFixed(2)})`);
                }}
                className="w-32 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer slider"
                style={{
                  background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${(currentIndex/2)*100}%, #e5e7eb ${(currentIndex/2)*100}%, #e5e7eb 100%)`
                }}
              />
            );
          })()}
          <span className="text-xs text-gray-500">0.5</span>
          <span className="text-xs font-medium text-blue-600 min-w-[3rem]">
            {warpCompensation.toFixed(2)}
          </span>
        </div>
        <span className="text-xs text-gray-500">
        </span>
      </div>

      {/* Fingertip compensation control */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">fingertip comp:</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">0</span>
          <input
            type="range"
            min="0"
            max="0.12"
            step="0.005"
            value={fingerCompStrength}
            onChange={(e) => setFingerCompStrength(parseFloat(e.target.value))}
            className="w-32 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer slider"
            style={{
              background: `linear-gradient(to right, #10b981 0%, #10b981 ${Math.min(
                100,
                (fingerCompStrength / 0.12) * 100
              )}%, #e5e7eb ${Math.min(100, (fingerCompStrength / 0.12) * 100)}%, #e5e7eb 100%)`,
            }}
          />
          <span className="text-xs text-gray-500">0.12</span>
          <span className="text-xs font-medium text-emerald-600 min-w-[3rem]">
            {fingerCompStrength.toFixed(3)}
          </span>
        </div>
      </div>

      {/* Perspective strength control */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">perspective:</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">0%</span>
          <input
            type="range"
            min="0"
            max="100"
            value={perspectiveStrength}
            onChange={(e) => {
              const value = parseInt(e.target.value);
              setPerspectiveStrength(value);
              setDebugInfo(`perspective strength: ${value}% (${(value * 0.3).toFixed(1)}deg)`);
            }}
            className="w-32 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer slider"
            style={{
              background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${perspectiveStrength}%, #e5e7eb ${perspectiveStrength}%, #e5e7eb 100%)`
            }}
          />
          <span className="text-xs text-gray-500">100%</span>
          <span className="text-xs font-medium text-blue-600 min-w-[3rem]">
            {perspectiveStrength}%
          </span>
        </div>
        <span className="text-xs text-gray-500">
          (near large, far small effect)
        </span>
      </div>

              <div 
         className="video-container relative overflow-hidden border rounded-xl bg-black"
         style={{
           width: '500px',
           height: '500px',
          touchAction: 'pan-x pan-y pinch-zoom' // Allow pan and zoom
         }}
        >
          {/* Hidden video element (used only as Three.js texture source) */}
          <video 
            ref={videoRef} 
            className="video-element" 
            playsInline 
            style={{
              display: 'none' // Hide native video; render via Three.js
            }}
          />
          
          {/* Three.js render canvas (realtime 3D) */}
          <canvas
            ref={threeCanvasRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '500px',
              height: '500px',
              pointerEvents: 'none' // No events; overlay handles input
            }}
          />
        {/* OCR overlay (word boxes only) */}
        <canvas
          ref={ocrOverlayCanvasRef}
          className="absolute inset-0 pointer-events-none"
          style={{ width: '500px', height: '500px' }}
        />
        {/* Overlay to receive gesture events */}
        <div
          ref={overlayRef}
          onPointerUp={(e) => {
            // Only Apple Pencil triggers OCR
            if (e.pointerType === "pen") {
              console.log('[Events] Apple Pencil PointerUp - 瑙﹀彂OCR');
              onPointerUp(e);
            } else {
              console.log('[Events] 闈濧pple Pencil浜嬩欢锛岃烦杩嘜CR:', e.pointerType);
            }
          }}
          onPointerDown={(e) => {
            // If dragging the floating panel, ignore other gestures
            if (isDraggingFloat) return;
            
            console.log('[Events] PointerDown:', {
              type: e.pointerType,
              pressure: e.pressure,
              x: e.clientX,
              y: e.clientY,
              isPrimary: e.isPrimary
            });
            
            if (e.pointerType === "pen") {
              // Apple Pencil - drawing only, no drag
              console.log('[Pencil] Apple Pencil down, preparing to draw');
              setDebugInfo(`Apple Pencil: pressure ${e.pressure?.toFixed(2) || 'N/A'}`);
            } else if (e.pointerType === "touch") {
              // Finger - used for zoom/drag
              console.log('[Finger] finger down, preparing gesture input');
              (e.currentTarget as any).lastPointerX = e.clientX;
              (e.currentTarget as any).lastPointerY = e.clientY;
              (e.currentTarget as any).initialTranslate = {...videoTranslate};
              (e.currentTarget as any).fingerPointerId = e.pointerId;
              setDebugInfo(`finger down: (${e.clientX.toFixed(0)}, ${e.clientY.toFixed(0)})`);
            }
          }}
          onTouchStart={(e) => {
            if (e.touches.length === 2) {
              // Two-finger zoom start (only touch can do multi-touch)
              const touch1 = e.touches[0];
              const touch2 = e.touches[1];
              const distance = Math.sqrt(
                Math.pow(touch2.clientX - touch1.clientX, 2) + 
                Math.pow(touch2.clientY - touch1.clientY, 2)
              );
              (e.currentTarget as any).initialDistance = distance;
              (e.currentTarget as any).initialScale = videoScale;
              console.log('[Zoom] 鍙屾寚缂╂斁寮€濮?', { distance, currentScale: videoScale });
              setDebugInfo(`zoom start (${distance.toFixed(0)}px)`);
            }
          }}
          onPointerMove={(e) => {
            // If dragging the floating panel, ignore other gestures
            if (isDraggingFloat) return;
            
            if (e.pointerType === "pen") {
              // Apple Pencil - drawing only, no drag
              return;
            } else if (e.pointerType === "touch") {
              // Finger drag (only when zoomed)
              const fingerPointerId = (e.currentTarget as any).fingerPointerId;
              const lastX = (e.currentTarget as any).lastPointerX;
              const lastY = (e.currentTarget as any).lastPointerY;
              const initialTranslate = (e.currentTarget as any).initialTranslate;
              
              if (e.pointerId === fingerPointerId && lastX !== undefined && lastY !== undefined && initialTranslate && videoScale > 1) {
                const deltaX = e.clientX - lastX;
                const deltaY = e.clientY - lastY;
                
                // Video is mirrored; X needs to be inverted
                setVideoTranslate({
                  x: initialTranslate.x - deltaX / videoScale, // Note the minus sign
                  y: initialTranslate.y + deltaY / videoScale
                });
                setDebugInfo(`finger drag: (${deltaX.toFixed(0)}, ${deltaY.toFixed(0)}) zoom:${(videoScale * 100).toFixed(0)}%`);
              }
            }
          }}
          onTouchMove={(e) => {
            e.preventDefault(); // Prevent page scrolling
            
            if (e.touches.length === 2) {
              // Two-finger zoom (only touch supports multi-touch)
              const touch1 = e.touches[0];
              const touch2 = e.touches[1];
              const distance = Math.sqrt(
                Math.pow(touch2.clientX - touch1.clientX, 2) + 
                Math.pow(touch2.clientY - touch1.clientY, 2)
              );
              
              const initialDistance = (e.currentTarget as any).initialDistance;
              const initialScale = (e.currentTarget as any).initialScale;
              
              if (initialDistance) {
                const scaleChange = distance / initialDistance;
                const newScale = Math.max(0.1, Math.min(10, initialScale * scaleChange));
                setVideoScale(newScale);
                setDebugInfo(`zoom: ${(newScale * 100).toFixed(0)}%`);
                console.log('[Zoom] 鍙屾寚缂╂斁:', newScale);
              }
            }
            // Remove single-finger drag; use PointerMove instead
          }}
          onTouchEnd={(e) => {
            if (e.touches.length === 0) {
              // All fingers lifted
              setDebugInfo(`zoom: ${(videoScale * 100).toFixed(0)}%`);
            }
          }}
          className="absolute inset-0 z-10 cursor-crosshair select-none"
          style={{ 
            touchAction: 'none', // Disable default touch behavior
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
            WebkitTapHighlightColor: 'transparent',
            pointerEvents: 'auto' // Ensure pointer events fire
          }}
          title="Use Apple Pencil to select the region"
        >
          {/* Visual feedback for finger detection mode */}
          {handDetectionMode === 'finger' && fingerTipPosition && (
            <>
              {/* Fingertip marker (always visible) */}
              <div
                className="absolute w-3 h-3 bg-red-500 rounded-full pointer-events-none border-2 border-white shadow-lg z-20"
                style={{
                  left: `${fingerTipPosition.x}px`,
                  top: `${fingerTipPosition.y}px`,
                  animation: isFingerLongPressLLMEnabled && longPressState.isActive ? 'none' : 'pulse 2s infinite'
                }}
              />

              {/* Debug label for nearest OCR word */}
              {debugNearestWord && (
                <div
                  className="absolute pointer-events-none z-30 bg-black bg-opacity-75 text-white text-xs px-2 py-1 rounded shadow-lg"
                  style={{
                    left: `${fingerTipPosition.x + 50}px`,
                    top: `${fingerTipPosition.y - 50}px`,
                    transform: 'translateX(-50%)',
                    maxWidth: '220px',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    overflow: 'hidden',
                  }}
                >
                  <span className="font-semibold">nearest:</span>{' '}
                  <span>{debugNearestWord.text || '(no text)'}</span>
                </div>
              )}
              
              {/* Long-press progress ring (only when finger long-press LLM is enabled) */}
              {isFingerLongPressLLMEnabled && longPressRef.current.startPosition && longPressState.currentDuration > 0 && (
                <div
                  className="absolute pointer-events-none z-25"
                  style={{
                    left: `${fingerTipPosition.x - 25}px`,
                    top: `${fingerTipPosition.y - 25}px`,
                    width: '50px',
                    height: '50px'
                  }}
                >
                  <svg width="50" height="50" className="transform -rotate-90">
                    {/* Background ring */}
                    <circle
                      cx="25"
                      cy="25"
                      r="20"
                      stroke="rgba(255,255,255,0.3)"
                      strokeWidth="3"
                      fill="none"
                    />
                    {/* Progress ring */}
                    <circle
                      cx="25"
                      cy="25"
                      r="20"
                      stroke={
                        longPressState.currentLevel === 'hard' ? '#ef4444' :
                        longPressState.currentLevel === 'medium' ? '#f59e0b' : '#10b981'
                      }
                      strokeWidth="3"
                      fill="none"
                      strokeDasharray={`${2 * Math.PI * 20}`}
                      strokeDashoffset={`${2 * Math.PI * 20 * (1 - Math.min(longPressState.currentDuration / longPressConfig.hardThreshold, 1))}`}
                      style={{
                        transition: 'stroke-dashoffset 0.1s ease-out, stroke 0.2s ease-out'
                      }}
                    />
                  </svg>
                  
                  {/* Center level indicator */}
                  <div
                    className="absolute inset-0 flex items-center justify-center text-white text-xs font-bold"
                    style={{
                      textShadow: '0 0 4px rgba(0,0,0,0.8)'
                    }}
                  >
                    {longPressState.currentLevel === 'hard' ? 'H' :
                     longPressState.currentLevel === 'medium' ? 'M' : 'L'}
                  </div>
                  
                  {/* Time display and hint */}
                  <div
                    className="absolute -bottom-8 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-70 text-white text-xs px-2 py-1 rounded whitespace-nowrap text-center"
                  >
                    <div>{(longPressState.currentDuration / 1000).toFixed(1)}s</div>
                    {longPressState.currentLevel === 'hard' && !longPressRef.current.hasTriggered && (
                      <div className="text-yellow-300 animate-pulse"> auto trigger</div>
                    )}
                    {longPressState.currentLevel !== 'hard' && longPressState.currentDuration >= longPressConfig.autoTriggerDelay && (
                      <div className="text-green-300"> release finger to confirm </div>
                    )}
                  </div>
                </div>
              )}
              
              {/* Selection preview (only when finger long-press LLM is enabled) */}
              {isFingerLongPressLLMEnabled && (() => {
                const previewArea = calculateFingerSelectionArea(fingerTipPosition);
                return (
                  <div
                    className="absolute border-2 pointer-events-none z-15"
                    style={{
                      left: `${previewArea.left}px`,
                      top: `${previewArea.top}px`,
                      width: `${previewArea.width}px`,
                      height: `${previewArea.height}px`,
                      borderColor: longPressState.isActive ? (
                        longPressState.currentLevel === 'hard' ? '#ef4444' :
                        longPressState.currentLevel === 'medium' ? '#f59e0b' : '#10b981'
                      ) : '#10b981',
                      transition: 'border-color 0.2s ease-out'
                    }}
                  >
                    {/* Region label */}
                    <div 
                      className="absolute -top-6 left-1/2 transform -translate-x-1/2 text-white text-xs px-2 py-1 rounded whitespace-nowrap"
                      style={{
                        backgroundColor: longPressState.isActive ? (
                          longPressState.currentLevel === 'hard' ? '#ef4444' :
                          longPressState.currentLevel === 'medium' ? '#f59e0b' : '#10b981'
                        ) : '#10b981',
                        transition: 'background-color 0.2s ease-out'
                      }}
                    >
                      {longPressState.isActive ? 
                        `${longPressState.currentLevel} (${(longPressState.currentDuration / 1000).toFixed(1)}s)` :
                        `selection area ${previewArea.width}x${previewArea.height}`
                      }
                    </div>
                  </div>
                );
              })()}
            </>
          )}

          {/* Interest detection visualization */}
          {isInterestDetectionEnabled && (
            <>
              {/* Movement trail visualization */}
              {/* {movementTrail.length > 1 && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none z-10">
                  <path
                    d={`M ${movementTrail.map(p => `${p.x},${p.y}`).join(' L ')}`}
                    stroke="#8B5CF6"
                    strokeWidth="2"
                    fill="none"
                    strokeDasharray="3,3"
                    opacity="0.6"
                  />
               
                  {movementTrail.slice(-20).map((point, index) => (
                    <circle
                      key={index}
                      cx={point.x}
                      cy={point.y}
                      r="2"
                      fill="#8B5CF6"
                      opacity={0.8 - (index * 0.03)}
                    />
                  ))}
                </svg>
              )} */}

              {/* Interest heatmap visualization */}
              {/* {Array.from(interestHeatmap.entries()).map(([key, score]) => {
                const [gridX, gridY] = key.split(',').map(Number);
                const x = gridX * interestDetectionConfig.heatmapGridSize;
                const y = gridY * interestDetectionConfig.heatmapGridSize;
                const opacity = Math.min(score / 100, 0.8);
                
                return (
                  <div
                    key={key}
                    className="absolute pointer-events-none z-5"
                    style={{
                      left: `${x - 15}px`,
                      top: `${y - 15}px`,
                      width: '30px',
                      height: '30px',
                      borderRadius: '50%',
                      background: `radial-gradient(circle, rgba(139, 92, 246, ${opacity}) 0%, rgba(139, 92, 246, ${opacity * 0.3}) 70%, transparent 100%)`,
                      animation: 'pulse 2s infinite'
                    }}
                  />
                );
              })} */}

              {/* Current interest score display */}
              {/* {fingerTipPosition && currentInterestScore > 5 && (
                <div
                  className="absolute pointer-events-none z-20 bg-purple-500 text-white text-xs px-2 py-1 rounded shadow-lg"
                  style={{
                    left: `${fingerTipPosition.x + 20}px`,
                    top: `${fingerTipPosition.y - 30}px`,
                    transform: 'translateX(-50%)'
                  }}
                >
                  鍏磋叮搴? {currentInterestScore.toFixed(1)}%
                </div>
              )} */}

              {/* Focus area highlights */}
              {/* {interestAnalysis && interestAnalysis.focusAreas.map((area, index) => (
                <div
                  key={index}
                  className="absolute pointer-events-none z-15 border-2 border-purple-400 rounded-lg"
                  style={{
                    left: `${area.x - area.radius}px`,
                    top: `${area.y - area.radius}px`,
                    width: `${area.radius * 2}px`,
                    height: `${area.radius * 2}px`,
                    opacity: Math.min(area.score / 100, 0.6),
                    animation: 'pulse 3s infinite'
                  }}
                >
                  <div className="absolute -top-6 left-1/2 transform -translate-x-1/2 bg-purple-500 text-white text-xs px-2 py-1 rounded">
                    鐑偣 {area.score.toFixed(0)}%
                  </div>
                </div>
              ))} */}
            </>
          )} 

          {/* Apple Pencil drawing path visualization */}
          {handDetectionMode === 'pencil' && drawingPath.length > 1 && (() => {
            // Compute travel distance
            let distance = 0;
            for (let i = 1; i < drawingPath.length; i++) {
              const dx = drawingPath[i].x - drawingPath[i-1].x;
              const dy = drawingPath[i].y - drawingPath[i-1].y;
              distance += Math.sqrt(dx * dx + dy * dy);
            }
            
            // Show path only if distance > 15px
            return distance > 15 ? (
              <svg className="absolute inset-0 w-full h-full pointer-events-none">
                <path
                  d={`M ${drawingPath.map(p => `${p.x},${p.y}`).join(' L ')}`}
                  stroke="#3B82F6"
                  strokeWidth="2"
                  fill="none"
                  strokeDasharray="5,5"
                  opacity="0.7"
                />
              </svg>
            ) : null;
          })()}
          
          {/* Apple Pencil current drawing point */}
          {handDetectionMode === 'pencil' && isPressed && drawingPath.length > 0 && (
            <div
              className="absolute w-2 h-2 bg-blue-500 rounded-full pointer-events-none"
              style={{
                left: `${drawingPath[drawingPath.length - 1].x - 4}px`,
                top: `${drawingPath[drawingPath.length - 1].y - 4}px`
              }}
            />
          )}
          
          {/* Selection bounds visualization */}
          {selectionBounds && (
            <div
              className="absolute border-2 border-blue-500 bg-blue-100 bg-opacity-20 pointer-events-none transparent"
              style={{
                left: `${selectionBounds.left}px`,
                top: `${selectionBounds.top}px`,
                width: `${selectionBounds.width}px`,
                height: `${selectionBounds.height}px`,
                opacity: 0.1,
       
              }}
            />
          )}

          <PressureInferenceOverlay
            enabled={isHandDetectionEnabled && handDetectionMode === 'finger'}
            videoRef={videoRef}
            fingerTipPosition={fingerTipPosition}
            fingerTipUv={fingerTipUv}
            onPrediction={handlePressureInferenceSnapshot}
          />
          
        </div>
        
        {/* Floating response - moved outside video container to avoid clipping */}
        {floatingResponse && (
          <div
            className="fixed z-50 select-none"
            style={{
              left: `${floatingResponse.position.x}px`,
              top: `${floatingResponse.position.y}px`,
              transform: 'translate(-50%, -100%)', // Center horizontally, offset up
              pointerEvents: 'auto', // Allow interaction
              width: '240px', // Fixed width to avoid drag resize
              minWidth: '240px',
              maxWidth: '240px'
            }}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('drag-handle')) {
                setIsDraggingFloat(true);
                (e.currentTarget as any).dragStartX = e.clientX;
                (e.currentTarget as any).dragStartY = e.clientY;
                (e.currentTarget as any).initialX = floatingResponse.position.x;
                (e.currentTarget as any).initialY = floatingResponse.position.y;
                console.log('[Float] started dragging floating response');
                e.preventDefault();
              }
            }}
            onPointerMove={(e) => {
              if (isDraggingFloat && floatingResponse) {
                const dragStartX = (e.currentTarget as any).dragStartX;
                const dragStartY = (e.currentTarget as any).dragStartY;
                const initialX = (e.currentTarget as any).initialX;
                const initialY = (e.currentTarget as any).initialY;
                
                if (dragStartX !== undefined && dragStartY !== undefined) {
                  const deltaX = e.clientX - dragStartX;
                  const deltaY = e.clientY - dragStartY;
                  
                  setFloatingResponse({
                    ...floatingResponse,
                    position: {
                      x: initialX + deltaX,
                      y: initialY + deltaY
                    }
                  });
                }
              }
            }}
            onPointerUp={() => {
              if (isDraggingFloat) {
                setIsDraggingFloat(false);
                console.log('[Float] 缁撴潫鎷栨嫿娴獥');
              }
            }}
            onPointerLeave={() => {
              if (isDraggingFloat) {
                setIsDraggingFloat(false);
                console.log('[Float] 鎷栨嫿娴獥绂诲紑鍖哄煙');
              }
            }}
          >
            <div className="bg-black bg-opacity-90 text-white text-xs rounded-lg shadow-xl backdrop-blur-sm border border-gray-600">
              {/* Title bar and close button */}
              <div className="drag-handle flex justify-between items-center p-2 pb-1 cursor-move border-b border-gray-600">
                <div className="text-gray-300 text-xs">AI Response</div>
                <button
                  onClick={() => {
                    setFloatingResponse(null);
                    console.log('[Float] 鍏抽棴娴獥');
                  }}
                  className="text-gray-400 hover:text-white transition-colors w-4 h-4 flex items-center justify-center rounded hover:bg-gray-700"
                  title="Close"
                >
                  x
                </button>
              </div>
              
              {/* Content area */}
              <div className="p-2 pt-1">
                <div className="whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {floatingResponse.text || "Analyzing..."}
                </div>
              </div>
              
              {/* Small arrow pointing to selection box */}
              <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-black bg-opacity-90 rotate-45 border-r border-b border-gray-600"></div>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 p-3 rounded-lg border bg-white max-w-md whitespace-pre-wrap text-sm text-gray-600">
        <div className="font-medium mb-1">Response</div>
        {answer || "Tap the video to OCR the region under your pen, then call LLM."}
      </div>

      {/* Main page: visible-area OCR actions */}
      <div className="mt-4 flex gap-2 flex-wrap">
        <button
          onClick={runRegionOCR}
          className="px-3 py-2 rounded-md text-white disabled:opacity-50"
          style={{ background: '#111827' }}
        >
          OCR Region (Whole Frame)
        </button>
        <button
          onClick={() => {
            sessionLogger.reset();
            sessionLogger.resetSessionIds();
            resetTopicRanking();
            setRankingSessionId(sessionLogger.getSummary().sessionId);
            setPageIndex(1);
          }}
          className="px-3 py-2 rounded-md border"
        >
          Reset Session IDs
        </button>
        <button
          onClick={resetSessionForNewPage}
          className="px-3 py-2 rounded-md border"
        >
          New Page (Reset Logs)
        </button>
        <button
          onClick={clearRegionOCR}
          disabled={!ocrWordsInRegion}
          className="px-3 py-2 rounded-md border disabled:opacity-50"
        >
          Clear OCR Region
        </button>
      </div>

      {/* Region OCR debug: show image/text from OCR Region button */}
      {(regionCapturedImage || regionRecognizedText) && (
        <div className="mt-2 p-3 rounded-lg border bg-white max-w-md">
          <div className="font-medium mb-2">Region OCR Debug</div>
          {regionCapturedImage && (
            <img
              src={regionCapturedImage}
              alt="Region OCR Image"
              className="border rounded max-w-full h-auto"
              style={{ maxHeight: '200px' }}
            />
          )}
          {regionRecognizedText && (
            <div className="mt-2 text-xs text-gray-800 whitespace-pre-wrap break-words">
              {regionRecognizedText}
            </div>
          )}
          {regionTopicsLoading && (
            <div className="mt-2 text-xs text-gray-500">
              Generating topics (for recommendation JSON)...
            </div>
          )}
          {regionTopicsError && (
            <div className="mt-2 text-xs text-red-500">
              {regionTopicsError}
            </div>
          )}
        </div>
      )}

      {/* Show captured image */}
      {capturedImage && (
        <div className="mt-4 p-3 rounded-lg border bg-white max-w-md">
          <div className="font-medium mb-2">Captured Image (for OCR)</div>
          <img 
            src={capturedImage} 
            alt="Captured ROI for OCR" 
            className="border rounded max-w-full h-auto"
            style={{ maxHeight: '200px' }}
          />
          <div className="text-xs text-gray-500 mt-1">
            This is the image region captured for OCR. If the image is blurry or has no text, OCR will fail.
          </div>
          {selectionBounds && (
            <div className="text-xs text-blue-600 mt-1">
              ROI: {selectionBounds.width.toFixed(0)}x{selectionBounds.height.toFixed(0)}px 
              (x: {selectionBounds.left.toFixed(0)}, y: {selectionBounds.top.toFixed(0)})
            </div>
          )}
        </div>
      )}

      {/* Topic selection toast */}
      {lastSelectedTopic && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
          <div className="px-3 py-2 rounded-full bg-black bg-opacity-80 text-white text-xs shadow-lg">
            topic selected: <span className="font-semibold">{lastSelectedTopic}</span>
          </div>
        </div>
      )}
      {downloadToast && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50">
          <div className="px-3 py-2 rounded-full bg-emerald-600 text-white text-xs shadow-lg">
            {downloadToast}
          </div>
        </div>
      )}

      {/* Topics + voice notes floating panel (non-blocking, collapsible) */}
      <div className="fixed right-4 top-1 z-40 pointer-events-none">
        <div className="pointer-events-auto w-72 max-w-[80vw] max-h-[calc(100vh-6rem)] bg-white/90 border border-gray-200 rounded-xl shadow-xl backdrop-blur-sm overflow-hidden flex flex-col">
          <div
            className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50 cursor-pointer flex-shrink-0"
            onClick={() => setIsTopicsPanelOpen((v) => !v)}
          >
            <div className="flex flex-col">
              <span className="text-xs font-medium text-gray-700">
                topics &amp; voice notes
              </span>
              <span className="text-[10px] text-gray-400">
                tap to expand / collapse
              </span>
            </div>
            <button
              type="button"
              className="ml-2 w-6 h-6 flex items-center justify-center rounded-full bg-gray-200 text-[10px] text-gray-700 hover:bg-gray-300"
            >
              {isTopicsPanelOpen ? "-" : "+"}
            </button>
          </div>

          {isTopicsPanelOpen && (
            <div className="p-3 space-y-3 overflow-y-auto flex-1">
              {/* Topics list */}
              <div className="text-[11px] text-gray-800">
                <div className="font-medium mb-1 flex items-center justify-between">
                  <span>Topics (for recommender)</span>
                  {regionTopicsLoading && (
                    <span className="text-[10px] text-gray-500 ml-2">
                      generating...
                    </span>
                  )}
                </div>
                {carryOverDebug && (
                  <div className="text-[10px] text-gray-500 mb-1">
                    {carryOverDebug}
                  </div>
                )}

                {regionTopicsError && (
                  <div className="mb-1 text-[10px] text-red-500">
                    {regionTopicsError}
                  </div>
                )}

                {(topicRankingModel || isTopicRankingLoading) && (
                  <div className="mb-1 text-[10px] text-gray-500">
                    ranking: {isTopicRankingLoading ? "updating..." : topicRankingModel ?? "ready"}
                  </div>
                )}

                {topicRankingError && (
                  <div className="mb-1 text-[10px] text-amber-600">
                    {topicRankingError}
                  </div>
                )}

                {topRankedTopics.length > 0 && (
                  <div className="mb-2 rounded-lg border border-emerald-100 bg-emerald-50/70 p-2">
                    <div className="text-[10px] font-medium uppercase tracking-wide text-emerald-700">
                      Top 3 now
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {topRankedTopics.map((topic) => (
                        <button
                          key={`ranked-${topic.rank}-${topic.text}`}
                          type="button"
                          onClick={() => {
                            handleTopicSelection(topic.text, "page_topic");
                          }}
                          className="rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] text-emerald-900 hover:bg-emerald-100"
                        >
                          <span className="font-semibold">#{topic.rank} {topic.text}</span>
                          <span className="ml-1 text-[10px] text-emerald-700">
                            {topic.score.toFixed(2)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {topicRankingDebug && (
                  <div className="mb-2 rounded border border-dashed border-gray-200 bg-gray-50 p-2 text-[10px] text-gray-600">
                    <div>
                      focus: {topicRankingDebug.focusTexts.length > 0 ? topicRankingDebug.focusTexts.join(" | ") : "-"}
                    </div>
                    <div className="mt-1">
                      samples: {topicRankingDebug.pointerCount} · norm: {topicRankingDebug.focusNorm.toFixed(2)} · history: {topicRankingDebug.historyUsed ? "yes" : "no"}
                    </div>
                  </div>
                )}

                {regionTopics && regionTopics.length > 0 ? (
                  <div className="flex flex-wrap gap-2 mt-1">
                    {regionTopics.map((t, i) => {
                      const rankedTopic = rankedTopicMap.get(normalizeTopicKey(t));
                      const isTopPick = rankedTopic?.rank === 1;
                      const isRecommended = (rankedTopic?.rank ?? Infinity) <= 3;

                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => {
                            handleTopicSelection(t, "page_topic");
                          }}
                          className={`px-2 py-1 rounded border text-[11px] ${
                            isTopPick
                              ? "border-emerald-500 bg-emerald-50"
                              : isRecommended
                              ? "border-sky-400 bg-sky-50"
                              : "border-gray-300 bg-gray-50 hover:bg-gray-100"
                          }`}
                        >
                          <span className="font-semibold">{t}</span>
                          {rankedTopic && (
                            <span className="ml-1 text-[10px] text-gray-500">
                              #{rankedTopic.rank} {rankedTopic.score.toFixed(2)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-1 text-[10px] text-gray-400">
                    no topics yet - run OCR first
                  </div>
                )}
              </div>

              {/* Voice topic recorder */}
              <div className="border-t border-dashed border-gray-200 pt-2 mt-1">
                <div className="text-[11px] text-gray-600 mb-1">
                  Press and speak (save as topic)
                </div>
                <VoiceTopicRecorder
                  onAnnotation={(ann) => {
                    sessionLogger.addVoiceAnnotation(ann);
                    setLastVoiceAnnotation(ann);
                    // Also record voice transcript as a selected topic
                    if (ann.transcript && ann.transcript.trim()) {
                      const topicText = ann.transcript.trim();
                      handleTopicSelection(topicText, "voice", ann.timestampEnd);
                    }
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Test buttons */}
      <div className="mt-4 flex gap-2 flex-wrap">
        <button
          onClick={async () => {
            console.log('[Test] 娴嬭瘯 OCR 鍔熻兘');
            setDebugInfo('test mode: simulate click');
            if (!ocrReady || !worker) {
              setAnswer("OCR not ready");
              return;
            }
            
            // Create a test image (white background, black text)
            const canvas = document.createElement("canvas");
            canvas.width = 300;
            canvas.height = 100;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, 300, 100);
            ctx.fillStyle = "black";
            ctx.font = "20px Arial";
            ctx.fillText("Hello World Test", 50, 50);
            
            try {
              setAnswer("test OCR...");
              const { data: { text } } = await worker.recognize(canvas);
              setAnswer(`test success! recognized text: "${text.trim()}"`);
              console.log('[Test] OCR 娴嬭瘯鎴愬姛:', text);
            } catch (err: any) {
              setAnswer(`test failed: ${err.message}`);
              console.error('[Test] OCR 娴嬭瘯澶辫触:', err);
            }
          }}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm"
        >
          Test OCR
        </button>
        
       
        {/* <button
          onClick={testWebGLScreenshot}
          className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 text-sm"
          title="Three.js 3D娓叉煋鎴浘锛堢湡瀹?D鍙樻崲锛宨Pad鍏煎锛?
        >
          馃幃 test Three.js
        </button> */}
        
        <button
          onClick={() => {
            setDebugInfo('');
            setAnswer('');
            setFloatingResponse(null); // Clear floating panel
            console.log('[Test] 娓呴櫎璋冭瘯淇℃伅');
          }}
          className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 text-sm"
        >
          clear
        </button>
        
        <button
          onClick={() => {
            setVideoScale(1);
            setVideoTranslate({x: 0, y: 0});
            setPerspectiveStrength(0);
            setDebugInfo('reset view');
            console.log('[Reset] 閲嶇疆缂╂斁銆佷綅缃拰閫忚');
          }}
          className="px-4 py-2 bg-indigo-500 text-white rounded hover:bg-indigo-600 text-sm"
        >
          Reset view
        </button>
        
        
        {isVideoFrozen && (
          <button
            onClick={() => {
              const video = videoRef.current;
              if (video) {
                video.play().catch(console.error);
                setIsVideoFrozen(false);
                setDrawingPath([]);
                setSelectionBounds(null);
                setCapturedImage("");
                console.log('[Video] 鎭㈠瑙嗛鎾斁');
              }
            }}
            className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 text-sm"
          >
            Resume video
          </button>
        )}
      </div>

      {/* iPad event test area */}
      {/* <div className="mt-4 p-4 border border-dashed border-gray-300 rounded-lg bg-yellow-50">
        <div className="text-sm font-medium mb-2"> iPad 浜嬩欢娴嬭瘯鍖哄煙</div>
        <div
          onPointerDown={(e) => {
            console.log('[TestArea] PointerDown:', e.pointerType, e.pressure);
            setDebugInfo(`娴嬭瘯鍖?PointerDown: ${e.pointerType}`);
          }}
          onPointerUp={(e) => {
            console.log('[TestArea] PointerUp:', e.pointerType, e.pressure);
            setDebugInfo(`娴嬭瘯鍖?PointerUp: ${e.pointerType} - 浜嬩欢姝ｅ父锛乣);
          }}
          onTouchStart={(e) => {
            console.log('[TestArea] TouchStart:', e.touches.length);
            setDebugInfo(`娴嬭瘯鍖?TouchStart: ${e.touches.length} 瑙︾偣`);
          }}
          onTouchEnd={(e) => {
            console.log('[TestArea] TouchEnd:', e.changedTouches.length);
            setDebugInfo(`娴嬭瘯鍖?TouchEnd: ${e.changedTouches.length} 瑙︾偣 - 浜嬩欢姝ｅ父锛乣);
          }}
          className="w-full h-20 bg-white border rounded cursor-pointer flex items-center justify-center text-gray-600"
          style={{
            touchAction: 'manipulation',
            userSelect: 'none',
            WebkitUserSelect: 'none'
          }}
        >
          鐐瑰嚮杩欓噷娴嬭瘯浜嬩欢鏄惁姝ｅ父 (鎵嬫寚/Apple Pencil)
        </div>
        <div className="text-xs text-gray-500 mt-1">
          濡傛灉杩欎釜鍖哄煙鑳芥娴嬪埌鐐瑰嚮锛岃鏄庝簨浠剁郴缁熸甯革紝闂鍙兘鍦ㄨ棰戣鐩栧眰
        </div>
      </div> */}

 

      {/* Show WebGL test screenshot */}
      {webglScreenshot && (
        <div className="mt-4 p-3 rounded-lg border bg-white max-w-md">
          <div className="font-medium mb-2">Three.js 3D Render Screenshot</div>
          <img 
            src={webglScreenshot} 
            alt="Three.js 3D Render Screenshot" 
            className="border rounded max-w-full h-auto"
            style={{ maxHeight: '300px' }}
          />
          <div className="text-xs text-gray-500 mt-1">
            This screenshot is captured from the Three.js WYSIWYG render, including the video, overlays, and current interaction state.
          </div>
          <div className="text-xs text-blue-600 mt-1">
            iPad friendly | True 3D perspective transform | High-resolution capture | Hardware accelerated | Includes overlay elements
          </div>
          <button
            onClick={() => setWebglScreenshot("")}
            className="mt-2 px-2 py-1 bg-gray-500 text-white rounded text-xs hover:bg-gray-600"
          >
            Clear
          </button>
        </div>
      )}

    </main>
  );
}















