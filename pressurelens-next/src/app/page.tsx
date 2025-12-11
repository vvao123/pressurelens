"use client";
import { useEffect, useRef, useState, useMemo } from "react";
import { createWorker, Worker } from "tesseract.js";
import { recognizeWordsFromCanvas, WordBBox } from "../lib/ocr/tesseract";
import * as THREE from "three";
import { sessionLogger } from "../lib/logging/sessionLogger";
import { getNearestOcrWord } from "../lib/logging/nearestWord";
import type { PointerSampleInput, VoiceAnnotation, NearestWordInfo } from "../lib/logging/types";
import VoiceTopicRecorder from "../components/VoiceTopicRecorder";

type Level = "light" | "medium" | "hard";

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
  const threePivotBaseYRef = useRef<number>(0); // record the base Y of the top pivot
  const shaderUniformsRef = useRef<{ u_map: { value: THREE.Texture | null }; u_comp: { value: number } } | null>(null);
  const [warpCompensation, setWarpCompensation] = useState<number>(0.5); // 0~0.5 recommended range, 0 is off
  // use ref to save the latest warpCompensation, avoid the old value being taken by the closure in the MediaPipe callback
  const warpCompensationRef = useRef<number>(warpCompensation);
  const offscreenRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureLockRef = useRef<boolean>(false);
  const ocrOverlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  
  // ref for long press detection, avoid frequent setState
  const longPressRef = useRef({
    startTime: 0,
    startPosition: null as {x: number, y: number} | null,
    currentLevel: 'light' as Level,
    hasTriggered: false,
    hasScreenshot: false // whether the screenshot has been taken
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
  const [isPressed, setIsPressed] = useState<boolean>(false); // whether the pressure is being applied
  const [isVideoFrozen, setIsVideoFrozen] = useState<boolean>(false); // whether the video is frozen
  const [drawingPath, setDrawingPath] = useState<{x: number, y: number}[]>([]); // drawing path
  const [selectionBounds, setSelectionBounds] = useState<{left: number, top: number, width: number, height: number} | null>(null); // selection area boundary
  const [isStreaming, setIsStreaming] = useState<boolean>(false); // whether the streaming display is enabled
  const [isProcessing, setIsProcessing] = useState<boolean>(false); // prevent repeated processing
  const [isEnhancementEnabled, setIsEnhancementEnabled] = useState<boolean>(false); // whether the image enhancement is enabled
  const [videoScale, setVideoScale] = useState<number>(1.49); // video scale ratio
  const [videoTranslate, setVideoTranslate] = useState<{x: number, y: number}>({x: 0, y: 0}); // video translation position
  const [floatingResponse, setFloatingResponse] = useState<{text: string, position: {x: number, y: number}} | null>(null); // floating window response
  const [isDraggingFloat, setIsDraggingFloat] = useState<boolean>(false); // whether the floating window is being dragged
  const [perspectiveStrength, setPerspectiveStrength] = useState<number>(67); // perspective strength 0-100

  const [webglScreenshot, setWebglScreenshot] = useState<string>(""); // WebGL screenshot result

  // OCR region result (main page)
  const [ocrWordsInRegion, setOcrWordsInRegion] = useState<WordBBox[] | null>(null);
  const [ocrRegion, setOcrRegion] = useState<{left: number; top: number; width: number; height: number} | null>(null);
  const [ocrScale, setOcrScale] = useState<number>(2);
  const [regionCapturedImage, setRegionCapturedImage] = useState<string>("");
  const [regionRecognizedText, setRegionRecognizedText] = useState<string>("");
  const [regionTopics, setRegionTopics] = useState<
    { text: string; weight: number; category?: string }[] | null
  >(null);
  const [regionTopicsLoading, setRegionTopicsLoading] = useState(false);
  const [regionTopicsError, setRegionTopicsError] = useState<string | null>(null);

  // data collection switch
  const [isLoggingEnabled, setIsLoggingEnabled] = useState<boolean>(false);
  const [lastVoiceAnnotation, setLastVoiceAnnotation] = useState<VoiceAnnotation | null>(null);

  // main page: OCR region processing
  const runRegionOCR = async () => {
    // do OCR on the entire visible container (not dependent on the blue region)
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
      setRegionRecognizedText(fullText);
    } catch {}

    // write the entire page OCR text to sessionLogger, and call LLM to extract topics
    if (!fullText) {
      setRegionTopics([]);
      sessionLogger.setPageOcr({ pageText: "", pageTopics: [] });
      return;
    }

    try {
      setRegionTopicsLoading(true);
      const res = await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: fullText, maxTopics: 30 }),
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
      const list = Array.isArray(data?.topics) ? data.topics : [];
      setRegionTopics(list);
      sessionLogger.setPageOcr({ pageText: fullText, pageTopics: list });
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
  };

  // draw OCR overlay word boxes to ocrOverlayCanvas
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

  // finger detection related state
  const [handResults, setHandResults] = useState<any>(null); // MediaPipe detection result
  const [fingerTipPosition, setFingerTipPosition] = useState<{x: number, y: number} | null>(null); // finger tip position
  const [isHandDetectionEnabled, setIsHandDetectionEnabled] = useState<boolean>(false); // whether the finger detection is enabled
  const [handDetectionMode, setHandDetectionMode] = useState<'pencil' | 'finger'>('pencil'); // input mode
  const [handsInstance, setHandsInstance] = useState<any>(null); // MediaPipe Hands instance
  
  // user interest detection related state
  const [isInterestDetectionEnabled, setIsInterestDetectionEnabled] = useState<boolean>(false); // whether the interest detection is enabled
  const [movementTrail, setMovementTrail] = useState<Array<{x: number, y: number, timestamp: number, speed: number}>>([]); // movement trail

  // synchronize warpCompensation to ref, for MediaPipe callback and Three projection use
  useEffect(() => {
    warpCompensationRef.current = warpCompensation;
  }, [warpCompensation]);
  const [interestHeatmap, setInterestHeatmap] = useState<Map<string, number>>(new Map()); // interest heatmap
  const [currentInterestScore, setCurrentInterestScore] = useState<number>(0); // current interest score
  const [detectedKeywords, setDetectedKeywords] = useState<string[]>([]); // detected keywords
  const [interestAnalysis, setInterestAnalysis] = useState<{
    totalInterestScore: number;
    averageSpeed: number;
    focusAreas: Array<{x: number, y: number, radius: number, score: number}>;
    topKeywords: Array<{keyword: string, score: number}>;
  } | null>(null); // interest analysis result

  // debug: current nearest OCR word for the finger tip
  const [debugNearestWord, setDebugNearestWord] = useState<NearestWordInfo | null>(null);
  
  // finger reading data sampling (about 10Hz): record finger tip position + nearest OCR word box
  useEffect(() => {
    if (!isLoggingEnabled) return;

    const intervalMs = 100; // 10Hz sampling rate
    let timer: number | undefined;

    const tick = () => {
      const pointer = fingerTipPosition;
      if (
        pointer &&
        ocrWordsInRegion &&
        ocrWordsInRegion.length > 0 &&
        ocrRegion &&
        ocrScale
      ) {
        const t0 = (typeof performance !== "undefined" && performance.now)
          ? performance.now()
          : Date.now();

        const nearest = getNearestOcrWord(
          ocrWordsInRegion,
          ocrRegion,
          ocrScale,
          pointer,
          { maxDistancePx: Infinity }
        );

        const t1 = (typeof performance !== "undefined" && performance.now)
          ? performance.now()
          : Date.now();
        const dt = t1 - t0;
        // in Next development mode, this log will appear in both browser console and dev server terminal
        if (dt > 0.1) {
          console.log(
            "[NearestWord][perf] cost:",
            dt.toFixed(3),
            "ms",
            "| words:",
            ocrWordsInRegion.length
          );
        }
        setDebugInfo(
   
        dt.toFixed(3)
        );

        // update log sampling
        const sample: PointerSampleInput = {
          timestamp: Date.now(),
          x: pointer.x,
          y: pointer.y,
          inputMode: handDetectionMode,
          nearestWord: nearest,
          pressure: currentPressure,
          level,
          interestScore: currentInterestScore,
          speed: undefined,
        };
        sessionLogger.addPointerSample(sample);

        // update debug nearest word
        setDebugNearestWord(nearest);
      } else {
        setDebugNearestWord({ text: "-1", bbox: { x: 0, y: 0, w: 0, h: 0 }, distance: Infinity });
        setDebugInfo(
          "pointer: " + (pointer ? "true" : "false") +
        "ocrWordsInRegion: " + (ocrWordsInRegion ? "true" : "false") +
        "ocrWordsInRegion.length: " + (ocrWordsInRegion?.length > 0 ? "true" : "false") +
        "ocrRegion: " + (ocrRegion ? "true" : "false") +
        "ocrScale: " + (ocrScale ? "true" : "false")
        );
      }

      timer = window.setTimeout(tick, intervalMs);
    };

    timer = window.setTimeout(tick, intervalMs);
    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [
    isLoggingEnabled,
    fingerTipPosition,
    ocrWordsInRegion,
    ocrRegion,
    ocrScale,
    handDetectionMode,
    currentPressure,
    level,
    currentInterestScore,
  ]);
  
  // long press detection related state (only keep the fields needed for UI)
  const [longPressState, setLongPressState] = useState<{
    isActive: boolean;
    currentDuration: number;
    currentLevel: Level;
    shouldTriggerOnMove: Level | false; // mark the level that should be triggered, false means not to trigger
    startPosition: {x: number, y: number} | null;
  }>({
    isActive: false,
    currentDuration: 0,
    currentLevel: 'light',
    shouldTriggerOnMove: false,
    startPosition: null
  });
  
  // finger detection configuration parameters
  const [handDetectionConfig, setHandDetectionConfig] = useState({
    minDetectionConfidence: 0.8,
    minTrackingConfidence: 0.8,
    modelComplexity: 1
  });

  // long press configuration parameters
  const longPressConfig = {
    positionTolerance: 15, // position tolerance (pixels)
    lightThreshold: 1800,   // light level threshold (milliseconds)
    mediumThreshold: 3000, // medium level threshold (milliseconds)
    hardThreshold: 5500,   // hard level threshold (milliseconds)
    autoTriggerDelay: 1800  // auto trigger delay (milliseconds)
  };

  // finger mode: long press automatically call LLM switch
  const [isFingerLongPressLLMEnabled, setIsFingerLongPressLLMEnabled] = useState<boolean>(true);

  // training topic selection (for toast display)
  const [lastSelectedTopic, setLastSelectedTopic] = useState<string | null>(null);

  // interest detection configuration parameters
  const interestDetectionConfig = {
    trailMaxLength: 1000, // trail maximum length
    speedThreshold: {
      slow: 0.5,    // slow threshold (pixels/milliseconds)
      fast: 3.0     // fast threshold (pixels/milliseconds)
    },
    stayTimeThreshold: 500, // stay time threshold (milliseconds)
    heatmapGridSize: 20,    // heatmap grid size (pixels)
    interestDecayRate: 0.95, // interest decay rate
    minInterestScore: 0.1   // minimum interest score
  };

  // speed detection core algorithm function
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
      
      // calculate speed
      if (updatedTrail.length > 0) {
        const lastPoint = updatedTrail[updatedTrail.length - 1];
        newPoint.speed = calculateSpeed(lastPoint, newPoint);
      }
      
      updatedTrail.push(newPoint);
      
      // limit the trail length
      if (updatedTrail.length > interestDetectionConfig.trailMaxLength) {
        updatedTrail = updatedTrail.slice(-interestDetectionConfig.trailMaxLength);
      }
      
      return updatedTrail;
    });
  };

  // rAF sampling: update the trail when the interest detection is enabled and the finger tip position exists, at ~60fps
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
    
    // analyze the behavior pattern of the last 10 points
    const recentPoints = trail.slice(-10);
    
    for (let i = 1; i < recentPoints.length; i++) {
      const point = recentPoints[i];
      const prevPoint = recentPoints[i - 1];
      
      // speed analysis
      if (point.speed < interestDetectionConfig.speedThreshold.slow) {
        slowMovementCount++;
      }
      
        // stay time analysis
      const timeDiff = point.timestamp - prevPoint.timestamp;
      if (timeDiff > interestDetectionConfig.stayTimeThreshold) {
        stayTimeCount++;
      }
    }
    
    // calculate interest score
    const speedScore = slowMovementCount / recentPoints.length; // 0-1
    const stayScore = stayTimeCount / recentPoints.length; // 0-1
    const densityScore = Math.min(trail.length / 50, 1); // 轨迹密度分数
    
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




 

  // detect device information
  useEffect(() => {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isIPad = /iPad/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
    const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua);
    
    const info = `device: ${isIPad ? 'iPad' : isIOS ? 'iPhone' : 'other'} | browser: ${isSafari ? 'Safari' : 'other'} | touch points: ${navigator.maxTouchPoints}`;
    setDeviceInfo(info);
    console.log('[Device]', info);
  }, []);

  // add mobile debug tool
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
          video: { 
            facingMode: { ideal: "user" },
            width: { ideal: 19200, min: 1280 },
            height: { ideal: 10800, min: 720 },
            frameRate: { ideal: 30, min: 15 },
            // add more constraints to get better quality
             aspectRatio: { ideal: 1 }
          }, 
          audio: false,
        });
        const v = videoRef.current!;
        v.srcObject = stream;
        v.muted = true;
        // wait for metadata to be ready before playing, ensure videoWidth/Height
        v.onloadedmetadata = async () => {
          try {
            await v.play();
            
            // try to set automatic focus
            try {
              const videoTrack = stream.getVideoTracks()[0];
              const capabilities = videoTrack.getCapabilities() as any;
              console.log('[Camera] camera capabilities:', capabilities);
              
              // if support focus, set to continuous automatic focus
              if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
                await videoTrack.applyConstraints({
                  advanced: [{ focusMode: 'continuous' } as any]
                });
                console.log('[Camera] ✅ continuous automatic focus enabled');
              } else if (capabilities.focusMode && capabilities.focusMode.includes('single-shot')) {
                await videoTrack.applyConstraints({
                  advanced: [{ focusMode: 'single-shot' } as any]
                });
                console.log('[Camera] ✅ single shot automatic focus enabled');
              } else {
                console.log('[Camera] ⚠️ device does not support automatic focus control, trying manual focus...');
                
                // if support manual focus distance setting
                if (capabilities.focusDistance) {
                  // set a medium focus distance (usually better for document reading)
                  const midDistance = (capabilities.focusDistance.min + capabilities.focusDistance.max) / 2;
                  await videoTrack.applyConstraints({
                    advanced: [{ focusDistance: midDistance } as any]
                  });
                  console.log('[Camera] ✅ manual focus distance set:', midDistance);
                } else {
                  console.log('[Camera] ⚠️ device does not support any focus control');
                }
              }
              
              // if support white balance, set to automatic
              if (capabilities.whiteBalanceMode && capabilities.whiteBalanceMode.includes('continuous')) {
                await videoTrack.applyConstraints({
                  advanced: [{ whiteBalanceMode: 'continuous' } as any]
                });
                console.log('[Camera] ✅ automatic white balance enabled');
              }
              
              // if support exposure, set to automatic
              if (capabilities.exposureMode && capabilities.exposureMode.includes('continuous')) {
                await videoTrack.applyConstraints({
                  advanced: [{ exposureMode: 'continuous' } as any]
                });
                console.log('[Camera] ✅ automatic exposure enabled');
              }
              
            } catch (constraintError) {
              console.warn('[Camera] failed to set camera constraints:', constraintError);
            }
            
            setVideoReady(true);
            
            // delay initialization of Three.js renderer, ensure video has started playing
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
  
    // initialize Three.js renderer (for real-time display of 3D effects)
  const initThreeRenderer = () => {
    const video = videoRef.current;
    const canvas = threeCanvasRef.current;
    
    if (!video || !canvas || video.videoWidth === 0) {
      console.warn('[Three.js Init] video not ready, delaying initialization');
      setTimeout(initThreeRenderer, 500);
      return;
    }
    
    console.log('[Three.js Init] starting initialization of Three.js real-time renderer');
    
    const containerWidth = 1000;
    const containerHeight = 1000;
    
    // create renderer
    const renderer = new THREE.WebGLRenderer({ 
      canvas,
      antialias: true,
      alpha: false
    });
    // handle high DPR devices, ensure rendering content aligns with CSS pixels
    renderer.setPixelRatio(Math.max(1, window.devicePixelRatio || 1));
    renderer.setSize(containerWidth, containerHeight, false);
    renderer.setClearColor(0x000000, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    threeRendererRef.current = renderer;
    
    // create scene
    const scene = new THREE.Scene();
    threeSceneRef.current = scene;
    
    // create camera (Perspective, matching CSS perspective(800px))
    const fov = 2 * Math.atan(containerHeight / (2 * 800)) * 180 / Math.PI; // derive FOV from perspective(800px)
    const aspect = containerWidth / containerHeight;
    const near = 0.1;
    const far = 5000;
    const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
    camera.position.set(0, 0, 800); // camera Z=perspective distance
    camera.lookAt(0, 0, 0);
    threeCameraRef.current = camera;
    
    // create video texture
    const videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.format = THREE.RGBAFormat;
    videoTexture.colorSpace = THREE.SRGBColorSpace;
    threeTextureRef.current = videoTexture;
    
    // calculate video plane size
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
    
    // create plane (put pivot around the top)
    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    // custom shader material: nonlinear compensation for Y after rotateX,reduce line spacing compression
    const uniforms = {
      u_map: { value: videoTexture as THREE.Texture },
      u_comp: { value: warpCompensation }, // 0~0.5 recommended
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
        uniform float u_comp; // 0 off,越大compensation越强
        varying vec2 v_uv;
        void main() {
          // y越靠近下方，压缩越明显；do reverse拉伸补偿：scaleY = 1.0 / mix(1.0, 1.0 + u_comp, v_uv.y)
          float scale = 1.0 / mix(1.0, 1.0 + u_comp, 1.0-v_uv.y);
          float cy = 0.5;
          float y = (v_uv.y - cy) * scale + cy; // 围绕中心做非线性拉伸
          vec2 uv2 = vec2(v_uv.x, clamp(y, 0.0, 1.0));
          gl_FragColor = texture2D(u_map, uv2);
        }
      `,
      transparent: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0, -planeHeight / 2, 0); // move the plane down by half the height, so the pivot is at the top
    threeMeshRef.current = mesh;
    mesh.scale.x *= -1; // horizontal mirror
    const pivot = new THREE.Object3D();
    pivot.position.set(0, planeHeight / 2, 0); // top as pivot
    pivot.add(mesh);
    scene.add(pivot);
    threePivotRef.current = pivot;
    threePivotBaseYRef.current = pivot.position.y;
    // apply initial transformation (avoid updating only when user interaction is required)
    try {
      // translate
      pivot.position.x = videoTranslate.x;
      pivot.position.y = threePivotBaseYRef.current - videoTranslate.y;
      // scale (keep horizontal mirror)
      mesh.scale.set(videoScale, videoScale, 1);
      mesh.scale.x *= -1;
      // perspective rotation
      const rotationAngle = -(perspectiveStrength / 100) * (Math.PI / 6);
      pivot.rotation.x = rotationAngle;
      // camera position (matching CSS perspective(800px))
      camera.position.set(0, 0, 800);
      camera.lookAt(0, 0, 0);
      // compensation strength
      if (shaderUniformsRef.current) {
        shaderUniformsRef.current.u_comp.value = warpCompensation;
      }
    } catch {}
    
    console.log('[Three.js Init] Three.js renderer initialized, plane size:', planeWidth, 'x', planeHeight);
    
    // start animation loop
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
      
      // update video texture
      if (texture) {
        texture.needsUpdate = true;
      }
      
      renderer.render(scene, camera);
    };
    animate();
  };

  // ===== Warp compensation: strictly follow the shader formula, and find the inverse function in the "top-based" coordinate system =====
  // the code in the shader (note the coordinate system of v_uv.y is bottom-based 0, top-based 1):
  //   float scale = 1.0 / mix(1.0, 1.0 + u_comp, 1.0 - v_uv.y);
  //   float cy = 0.5;
  //   float y  = (v_uv.y - cy) * scale + cy;
  //   vec2 uv2 = vec2(v_uv.x, clamp(y, 0.0, 1.0));
  //
  // MediaPipe's v is "top-based 0, bottom-based 1", so we first convert it to the same top-based coordinate system for derivation:
  //
  //   let y_t = 1.0 - v_uv.y  (top-based: 0=top,1=bottom)
  //       y2_t = 1.0 - uv2_y
  //
  // we can derive the forward warp in the top-based coordinate system:
  //   y2_t = 0.5 - (0.5 - y_t) / (1.0 + c * y_t)    (c = u_comp)
  //
  // here we implement:
  //   1) applyWarpTop(y_t, c)   : y_t -> y2_t   (strictly equivalent to the warp in the shader)
  //   2) invertVerticalWarp(v, c): known "original video coordinates" v (= y2_t, 0=top,1=bottom),
  //                                through numerical binary search to find the corresponding geometric parameter y_t,
  //                                then use it as the v of the plane to participate in 3D perspective projection.
  const applyWarpTop = (vTop: number, comp: number): number => {
    if (comp <= 0) return vTop;
    const denom = 1 + comp * vTop;
    if (denom <= 1e-6) return Math.min(1, Math.max(0, vTop));
    const y2 = 0.5 - (0.5 - vTop) / denom;
    return Math.min(1, Math.max(0, y2));
  };

  const invertVerticalWarp = (vSample: number, comp: number): number => {
    if (comp <= 0) return vSample;
    // simple monotonic binary search: find applyWarpTop(v, comp) ≈ vSample in [0,1]
    let low = 0;
    let high = 1;
    let mid = vSample;
    for (let i = 0; i < 24; i++) {
      mid = (low + high) / 2;
      const y2 = applyWarpTop(mid, comp);
      if (y2 > vSample) {
        high = mid;
      } else {
        low = mid;
      }
    }
    const vPlane = (low + high) / 2;
    return Math.min(1, Math.max(0, vPlane));
  };

  // map MediaPipe normalized video coordinates (u,v in [0,1]) to overlay screen coordinates
  const projectVideoUVToOverlay = (u: number, v: number): {x: number; y: number} | null => {
    const renderer = threeRendererRef.current;
    const camera = threeCameraRef.current;
    const mesh = threeMeshRef.current;
    if (!renderer || !camera || !mesh) return null;

    // take the latest compensation value from the ref, avoid the old value being taken by the closure in the MediaPipe callback
    const comp = warpCompensationRef.current;

    // note: MediaPipe gives "original video coordinates" (corresponding to uv2.y in the shader),
    // but the three.js plane geometry uses v_uv.y as the parameter coordinate.
    // we need to find such v_uv.y, that warp(v_uv.y) ≈ v (i.e. the height of this line pixel finally appears on the plane),
    // so we use the inverse function to map v back to the geometric parameter coordinate.
    const vPlane = invertVerticalWarp(v, comp);

    // get the plane size
    const geom = mesh.geometry as THREE.PlaneGeometry;
    const planeWidth = geom.parameters.width as number;
    const planeHeight = geom.parameters.height as number;
    // video UV → mesh local coordinates (mesh local origin is at the center of the video, +X right, +Y up)
    const localX = (u - 0.5) * planeWidth;
    // const localY = (0.5 - v) * planeHeight; // v向下 → Three 向上（旧版本）
    const localY = (0.5 - vPlane) * planeHeight; // v向下 → Three 向上（用反warp后的 vPlane）
    const local = new THREE.Vector3(localX, localY, 0);
    // convert to world coordinates
    const world = local.clone().applyMatrix4(mesh.matrixWorld);
    // project to NDC
    const ndc = world.clone().project(camera);
    // NDC → screen pixels (using the CSS size of the rendering canvas)
    const cssW = renderer.domElement.clientWidth || 500;
    const cssH = renderer.domElement.clientHeight || 500;
    const x = (ndc.x * 0.5 + 0.5) * cssW;
    const y = (-ndc.y * 0.5 + 0.5) * cssH;
    return { x, y };
  };

  // tool: capture WYSIWYG region from Three.js rendering canvas (considering DPR)
  const captureWYSIWYGRegion = (region: {left: number; top: number; width: number; height: number}) => {
    const renderer = threeRendererRef.current;
    const scene = threeSceneRef.current;
    const camera = threeCameraRef.current;
    if (!renderer || !scene || !camera) return null;
    // force render a frame to ensure the content is latest
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

  // high-resolution WYSIWYG capture: use off-screen renderer to render at scale and then capture
  const captureWYSIWYGRegionHiRes = (region: {left: number; top: number; width: number; height: number}, scale: number = 2) => {
    const baseRenderer = threeRendererRef.current;
    const scene = threeSceneRef.current;
    const camera = threeCameraRef.current;
    if (!baseRenderer || !scene || !camera) return null;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = baseRenderer.domElement.clientWidth || 500;
    const cssH = baseRenderer.domElement.clientHeight || 500;
    // reuse off-screen renderer
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
    // reuse capture canvas
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
  
  // listen to changes in transformation parameters, update the Three.js scene in real-time (using pivot to simulate CSS transform-origin: top)
  useEffect(() => {
    const mesh = threeMeshRef.current;
    const pivot = threePivotRef.current;
    const camera = threeCameraRef.current;
    
    if (!mesh || !pivot || !camera) return;
    
    // match the order of CSS: transform-origin: top → translate → scale/flip → rotateX
    // 1) translate (with pivot as reference, keep the top pivot baseline)
    pivot.position.x = videoTranslate.x;
    pivot.position.y = threePivotBaseYRef.current - videoTranslate.y;
    // in the effect of updating the transformation (at the same time as pivot.position.y)


    
      // 2) scale
    mesh.scale.set(videoScale, videoScale, 1);
    mesh.scale.x *= -1; // horizontal mirror
    
    // 3) perspective rotation: around the X axis negative angle (bottom gets bigger)
    const rotationAngle = -(perspectiveStrength / 100) * (Math.PI / 6); // 0 to -20 degrees
    pivot.rotation.x = rotationAngle;
    
    // 4) camera matches CSS perspective(800px)
    camera.position.set(0, 0, 800);
    camera.lookAt(0, 0, 0);
    // update compensation strength
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
        
        const w = await createWorker('eng', 1, {
          // logger: (m: any) => console.log('[tesseract]', m),
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

  // 3) create/destroy MediaPipe Hands instance (only depends on the enabled state)
  useEffect(() => {
    if (!isHandDetectionEnabled) {
      // clean up existing instance
      if (handsInstance) {
        handsInstance.close();
        setHandsInstance(null);
      }
      setHandResults(null);
      setFingerTipPosition(null);
      return;
    }

    let mounted = true;
    
    const initializeHandDetection = async () => {
      try {
        console.log('[HandDetection] start initializing MediaPipe Hands...');
        
        // use CDN to load MediaPipe Hands
        if (!(window as any).Hands) {
          // dynamically load MediaPipe script
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
          maxNumHands: 1, // only detect one hand
          modelComplexity: handDetectionConfig.modelComplexity, // use the configured model complexity
          minDetectionConfidence: handDetectionConfig.minDetectionConfidence, // use the configured detection confidence
          minTrackingConfidence: handDetectionConfig.minTrackingConfidence,  // use the configured tracking confidence
          selfieMode: false, // not use selfie mode (avoid extra mirror processing)
          staticImageMode: false // use video mode rather than static image mode
        });
        
        hands.onResults((results: any) => {
          if (!mounted) return;
          
          setHandResults(results);
          
          if (results.multiHandLandmarks && results.multiHandLandmarks[0]) {
            const landmarks = results.multiHandLandmarks[0];
            // get the coordinate of the index finger tip (landmark 8)
            const fingerTip = landmarks[8];
            
            // convert to pixel coordinates (considering the actual display area of the video)
            const videoContainer = document.querySelector('.video-container') as HTMLElement;
            const video = videoRef.current;
            if (videoContainer && video) {
              const containerRect = videoContainer.getBoundingClientRect();
              
              // key: calculate the actual display area of the video in the container
              const videoAspect = video.videoWidth / video.videoHeight;
              const containerAspect = containerRect.width / containerRect.height;
              
              let videoDisplayWidth, videoDisplayHeight, videoOffsetX, videoOffsetY;
              
              if (videoAspect > containerAspect) {
                // the video is wider, take the container width as the basis
                videoDisplayWidth = containerRect.width;
                videoDisplayHeight = containerRect.width / videoAspect;
                videoOffsetX = 0;
                videoOffsetY = (containerRect.height - videoDisplayHeight) / 2;
              } else {
                // the video is higher, take the container height as the basis
                videoDisplayHeight = containerRect.height;
                videoDisplayWidth = containerRect.height * videoAspect;
                videoOffsetX = (containerRect.width - videoDisplayWidth) / 2;
                videoOffsetY = 0;
              }
              
              // use Three.js projection, get the pixel coordinates on the overlay
              const projected = projectVideoUVToOverlay(fingerTip.x, fingerTip.y);
              if (!projected) return;
              const { x, y } = projected;
              setFingerTipPosition({ x, y });

              
              // long press detection logic (using ref to reduce setState)
              const currentTime = Date.now();
              const newPosition = { x, y };
              
              // check if it is in the same position (within the tolerance range)
              if (longPressRef.current.startPosition) {
                const distance = Math.sqrt(
                  Math.pow(newPosition.x - longPressRef.current.startPosition.x, 2) + 
                  Math.pow(newPosition.y - longPressRef.current.startPosition.y, 2)
                );
                
                if (distance <= longPressConfig.positionTolerance) {
                  // in the same position, update the duration
                  const duration = currentTime - longPressRef.current.startTime;
                  let currentLevel: Level = 'light';
                  
                  if (duration >= longPressConfig.hardThreshold) {
                    currentLevel = 'hard';
                  } else if (duration >= longPressConfig.mediumThreshold) {
                    currentLevel = 'medium';
                  } else if (duration >= longPressConfig.lightThreshold) {
                    currentLevel = 'light';
                  }
                  
                  // update ref
                  longPressRef.current.currentLevel = currentLevel;
                  
                  // take screenshot when reaching the light level (only take once)
                  if (duration >= longPressConfig.lightThreshold && !longPressRef.current.hasScreenshot) {
                    takeFingerScreenshot(newPosition);
                  }
                  
                  // only setState when the UI needs to be updated (reduce frequency)
                  const isActive = duration >= longPressConfig.autoTriggerDelay;
                  if (longPressState.isActive !== isActive || 
                      longPressState.currentLevel !== currentLevel ||
                      Math.abs(longPressState.currentDuration - duration) > 100) { // 100ms更新一次UI
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
                  // the position changed too much, mark that OCR needs to be triggered
                  const shouldTrigger = !longPressRef.current.hasTriggered && 
                                       (currentTime - longPressRef.current.startTime) >= longPressConfig.autoTriggerDelay;
                  
                  // 先保存当前等级，再重置 ref，避免触发等级被覆盖成 light
                  const prevLevel = longPressRef.current.currentLevel;
                  
                  // reset ref（用于后续继续检测新的长按）
                  longPressRef.current = {
                    startTime: currentTime,
                    startPosition: newPosition,
                    currentLevel: 'light',
                    hasTriggered: false,
                    hasScreenshot: false
                  };
                  
                  // update state，触发时使用之前的等级
                  const triggerLevel = shouldTrigger ? prevLevel : false;
                  setLongPressState({
                    isActive: false,
                    currentDuration: 0,
                    currentLevel: 'light',
                    shouldTriggerOnMove: triggerLevel,
                    startPosition: null
                  });
                }
              } else {
                // first time detecting the finger position
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
          } else {
            setFingerTipPosition(null);
            // when the finger disappears, reset the long press state
            const shouldTrigger = !longPressRef.current.hasTriggered && 
                                 longPressRef.current.startPosition &&
                                 (Date.now() - longPressRef.current.startTime) >= longPressConfig.autoTriggerDelay;
            
            // 同样先保存当前等级，再重置 ref
            const prevLevel = longPressRef.current.currentLevel;
            const triggerLevel = shouldTrigger ? prevLevel : false;

            longPressRef.current = {
              startTime: 0,
              startPosition: null,
              currentLevel: 'light',
              hasTriggered: false,
              hasScreenshot: false
            };
            
            // update state
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
        console.log('[HandDetection] ✅ MediaPipe Hands initialized');
        
        // start processing video frames (optimize frame rate control)
        let lastFrameTime = 0;
        const targetFPS = 30; // target frame rate
        const frameInterval = 1000 / targetFPS;
        
        const processFrame = async (currentTime: number = 0) => {
          const video = videoRef.current;
          
          // control frame rate, avoid excessive processing
          if (currentTime - lastFrameTime >= frameInterval) {
            if (video && video.readyState >= 2 && mounted && isHandDetectionEnabled) {
              try {
                await hands.send({ image: video });
                lastFrameTime = currentTime;
              } catch (error) {
                console.warn('[HandDetection] failed to process frame:', error);
              }
            }
          }
          
          if (mounted && isHandDetectionEnabled) {
            requestAnimationFrame(processFrame);
          }
        };
        
        processFrame();
        
      } catch (error) {
        console.error('[HandDetection] MediaPipe Hands initialization failed:', error);
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
          console.warn('[HandDetection] error when cleaning up instance:', error);
        }
      }
    };
  }, [isHandDetectionEnabled]); // only depends on the enabled state

  // 4) update MediaPipe Hands configuration (without rebuilding the instance)
  useEffect(() => {
    if (handsInstance && isHandDetectionEnabled) {
      console.log('[HandDetection] update configuration:', handDetectionConfig);
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

  // long press automatically trigger OCR (only when the hard level is reached)
  useEffect(() => {
    if (!isFingerLongPressLLMEnabled) return;

    if (
      longPressState.isActive && 
      longPressState.currentLevel === 'hard' &&
      longPressState.currentDuration >= longPressConfig.hardThreshold && 
      !longPressRef.current.hasTriggered && 
      fingerTipPosition && 
      !isProcessing
    ) {
      
      console.log('[LongPress] hard level reached, automatically trigger OCR, duration:', longPressState.currentDuration);
      
      // mark as triggered
      longPressRef.current.hasTriggered = true;
      
      
      const triggerLevel: Level = 'hard';
      setLevel(triggerLevel);
      
      // trigger OCR with explicit level
      onFingerSelection(triggerLevel);
    }
  }, [isFingerLongPressLLMEnabled, longPressState.isActive, longPressState.currentDuration, longPressState.currentLevel, fingerTipPosition, isProcessing]);

  

  // listen to the finger move away/disappear and trigger OCR
  useEffect(() => {
    if (!isFingerLongPressLLMEnabled) return;

    const triggerLevel = longPressState.shouldTriggerOnMove;
    if (!triggerLevel || isProcessing) return;

    console.log('[LongPress] finger move away/disappear trigger OCR, using level:', triggerLevel);
    
    // mark as triggered
    longPressRef.current.hasTriggered = true;
    
    // set level and trigger OCR with explicit level
    setLevel(triggerLevel);
    onFingerSelection(triggerLevel as Level);
    
    // clear trigger flag
    setLongPressState(prev => ({
      ...prev,
      shouldTriggerOnMove: false
    }));
  }, [isFingerLongPressLLMEnabled, longPressState.shouldTriggerOnMove, isProcessing]);

    // 3) Apple Pencil pressure three levels (with slight anti-shake)
  useEffect(() => {
    const el = overlayRef.current!;
    let last: Level = "light";
    let lastPressure = 0;
    let maxLevelInSession: Level = "light"; // record the highest level of the current press
    let isPressed = false; // whether the pen is pressed
    let t: any;
    
    // downgrade mechanism related variables
    let downgradeTimer: any;
    let pendingDowngradeLevel: Level | null = null;
    let stableStartTime = 0;
    
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        // pause the video
        const video = videoRef.current!;
        if (video && !video.paused) {
          video.pause();
          setIsVideoFrozen(true);
          console.log('[Drawing] video paused, start drawing mode');
        }
        
        isPressed = true;
        setIsPressed(true); // update the component state
        maxLevelInSession = "light"; // reset the highest level
        setCurrentMaxLevel("light"); // synchronize the state
        
        // start a new drawing path
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setDrawingPath([{x, y}]);
        setSelectionBounds(null);
        
        // clear any ongoing downgrade
        clearTimeout(downgradeTimer);
        pendingDowngradeLevel = null;
        stableStartTime = 0;
        console.log('[Pressure] start a new press session');
      }
    };
    
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === "pen" && isPressed) {
        isPressed = false;
          setIsPressed(false); // update the component state
        
        // clear the downgrade timer
        clearTimeout(downgradeTimer);
        pendingDowngradeLevel = null;
        
        // use the highest level of the current press
        setLevel(maxLevelInSession);
        setCurrentMaxLevel("light"); // reset the display state
        console.log('[Pressure] press end, using the highest level:', maxLevelInSession);
        setDebugInfo(`pressure end | final level: ${maxLevelInSession}`);
        
        // note: do not calculate selectionBounds here, handle it in onPointerUp
      }
    };
    
    const onMove = (e: PointerEvent) => {
      const p = e.pressure ?? 0;
      const isPen = e.pointerType === "pen";
      
      // update the pressure and device type state
      setCurrentPressure(p);
      setIsUsingPen(isPen);
      
      if (!isPen) return;
      
      // if the pen is pressed, record the drawing path
      if (isPressed) {
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setDrawingPath(prev => {
          const newPath = [...prev, {x, y}];
          if (newPath.length % 5 === 0) { // print every 5 points to avoid too many logs
            console.log('[Drawing] path points:', newPath.length, 'latest point:', {x: x.toFixed(1), y: y.toFixed(1)});
          }
          return newPath;
        });
      }
      
      if (!isPressed) return; // only process the pressure level during the press
      
      // Apple Pencil 1 and 2 have pressure sensing
      const currentLevel: Level = p < 0.33 ? "light" : p < 0.66 ? "medium" : "hard";
      
      // upgrade logic: immediately upgrade to a higher level
      if (currentLevel === "hard" || (currentLevel === "medium" && maxLevelInSession === "light")) {
        maxLevelInSession = currentLevel;
        setCurrentMaxLevel(currentLevel); // synchronize the state
        clearTimeout(downgradeTimer); // clear the downgrade timer
        pendingDowngradeLevel = null;
        stableStartTime = 0;
      }
      
      // downgrade logic: need to be stable for 0.5 seconds to downgrade
      const levelOrder = { "light": 0, "medium": 1, "hard": 2 };
      if (levelOrder[currentLevel] < levelOrder[maxLevelInSession]) {
        // the current pressure level is lower than the highest level, start the downgrade timer
        
        if (pendingDowngradeLevel !== currentLevel) {
          // start a new downgrade timer
          pendingDowngradeLevel = currentLevel;
          stableStartTime = Date.now();
          clearTimeout(downgradeTimer);
          
          downgradeTimer = setTimeout(() => {
            // 0.5 seconds later confirm the downgrade
            if (pendingDowngradeLevel === currentLevel && isPressed) {
              maxLevelInSession = currentLevel;
              setCurrentMaxLevel(currentLevel); // synchronize the state
              console.log('[Pressure] stable downgrade to:', currentLevel);
              setDebugInfo(`✏️ pressure: ${p.toFixed(3)} | downgrade to: ${currentLevel} | current highest: ${maxLevelInSession}`);
            }
          }, 500); // 0.5 seconds stable time
          
          console.log('[Pressure] start downgrade timer to:', currentLevel);
        }
        
        // display the downgrade countdown
        const elapsed = Date.now() - stableStartTime;
        const remaining = Math.max(0, 500 - elapsed);
        setDebugInfo(`✏️ pressure: ${p.toFixed(3)} | current: ${currentLevel} | highest: ${maxLevelInSession} | downgrade countdown: ${(remaining/1000).toFixed(1)}s`);
        
      } else {
        // pressure continues to increase, cancel the downgrade
        if (pendingDowngradeLevel) {
          clearTimeout(downgradeTimer);
          pendingDowngradeLevel = null;
          stableStartTime = 0;
        }
        
        // normal display
        setDebugInfo(`✏️ pressure: ${p.toFixed(3)} | current: ${currentLevel} | highest: ${maxLevelInSession}`);
      }
      
    };
    
    const onLeave = () => {
      setCurrentPressure(0);
      setIsUsingPen(false);
      setDebugInfo('');
      isPressed = false;
      setIsPressed(false); // update the component state
      setCurrentMaxLevel("light"); // reset the display state
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

  // 4) calculate the selection area based on the finger position
  const calculateFingerSelectionArea = (fingerPos: {x: number, y: number}) => {
    // create a selection area above the finger
    const areaWidth = 120;  // selection area width
    const areaHeight = 80;  // selection area height
    const offsetY = -60;   // offset upwards, avoid blocking the finger
    
    return {
      left: Math.max(0, fingerPos.x - areaWidth / 2),
      top: Math.max(0, fingerPos.y + offsetY - areaHeight / 2),
      width: areaWidth,
      height: areaHeight
    };
  };




  // 5) finger mode screenshot function (called when the light level is reached)
  const takeFingerScreenshot = async (fingerPos: {x: number, y: number}) => {
    if (longPressRef.current.hasScreenshot) {
      return; // already taken a screenshot
    }
    
    console.log('[Screenshot] light level reached, start screenshot, position:', fingerPos);
    longPressRef.current.hasScreenshot = true;
    
    // finger mode keep the video playing, do not pause! otherwise cannot continue to detect the finger position
    console.log('[Screenshot] finger mode keep the video playing, continue to detect the finger position');
    
    // calculate the selection area
    const selectionArea = calculateFingerSelectionArea(fingerPos);
    setSelectionBounds(selectionArea);
    
    // here only take a screenshot, do not do OCR, OCR留给后续的触发逻辑
    console.log('[Screenshot] screenshot completed, waiting for OCR trigger');
  };

  // 6) finger selection processing function (OCR processing, using the already taken screenshot)
  // explicitly pass the triggerLevel to avoid relying on potentially delayed React state
  const onFingerSelection = async (triggerLevel?: Level) => {
    if (captureLockRef.current) { console.log('[Finger] capture busy, skip'); return; }
    captureLockRef.current = true;
    if (!selectionBounds || !videoReady || !ocrReady || !worker) {
      console.log('[Finger] conditions not met:', { 
        hasSelectionBounds: !!selectionBounds, 
        videoReady, 
        ocrReady, 
        hasWorker: !!worker 
      });
      return;
    }
    
    if (isProcessing) {
      console.log('[Finger] already processing, skip');
      return;
    }
    setIsProcessing(true);
    
    console.log(
      '[Finger] start OCR processing, using the screenshot area:',
      selectionBounds,
      'triggerLevel param:',
      triggerLevel,
      'current longPress level (ref):',
      longPressRef.current.currentLevel,
      'state level:',
      level
    );
    
    setDebugInfo(`👆 finger mode: selection area ${selectionBounds.width}×${selectionBounds.height}px`);
    
    // use Three.js to render the scene and take a WYSIWYG screenshot
    try {
      const renderer = threeRendererRef.current;
      const scene = threeSceneRef.current;
      const camera = threeCameraRef.current;
      const renderCanvas = renderer?.domElement;
      if (!renderer || !scene || !camera || !renderCanvas) {
        console.warn('[Finger] Three.js not ready, revert to old screenshot logic');
        // if not ready, keep the old path (to avoid interruption)
        return;
      }
      
      // directly render the selected area from the Three canvas (consider DPR)
      // high resolution export (scale=2 or 3可选)
      // iPad etc. devices downgrade scale to avoid OOM
      const isIPad = /iPad|iPhone|iPod/.test(navigator.userAgent) || ((/Macintosh/.test(navigator.userAgent)) && (navigator.maxTouchPoints > 1));
      const scale = isIPad ? 1.5 : 2;
      const cropCanvas = captureWYSIWYGRegionHiRes(selectionBounds, scale) || captureWYSIWYGRegion(selectionBounds);
      if (!cropCanvas) {
        console.error('[Finger] WYSIWYG crop failed, canvas is empty');
        setIsProcessing(false);
        return;
      }
      console.log('[Finger] finger mode screenshot completed (Three.js WYSIWYG)');
      
      // image enhancement processing
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
        console.log('[Finger] ✅ image enhancement completed');
      }
      
      // get the processed image (use WYSIWYG)
      const imageDataUrl = cropCanvas.toDataURL();
      // delay updating the UI, to avoid blocking the main thread
      setTimeout(() => {
        try { setCapturedImage(imageDataUrl); } catch {}
      }, 0);
      
      // OCR recognition
      console.log('[Finger] start OCR recognition...', {
        triggerLevel,
        currentLevelState: level,
        longPressLevelRef: longPressRef.current.currentLevel,
        longPressStateSnapshot: longPressState
      });
      const { data: { text } } = await worker.recognize(cropCanvas);
      const picked = text.trim().slice(0, 400);
      
      console.log('[Finger] OCR recognition result:', { 
        originalLength: text.length, 
        trimmedLength: picked.length, 
        text: picked 
      });
      
      // use the triggerLevel if provided, otherwise use the ref's current level, and finally fall back to the state level
      const finalLevel: Level =
        triggerLevel ||
        longPressRef.current.currentLevel ||
        level;
      console.log('[Finger] prepare to call LLM with level:', finalLevel, {
        triggerLevel,
        stateLevel: level,
        refLevel: longPressRef.current.currentLevel,
      });

      setAnswer(`👆 finger mode: call LLM... (level: ${finalLevel})\n\ntext: ${picked || "(no text detected)"}`);
      
      // if(picked.length === 0) {
      //   setAnswer("👆 finger mode: no text detected");
      //   console.log('[Finger] text is empty');
      //   return;
      // }
      
      // call LLM (finger mode: tell LLM the finger position in the middle of the screenshot)
      const resp = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: picked || "No text",
          level: finalLevel,
          image: imageDataUrl,
          streaming: isStreaming,
          focusHint: "This image is a cropped region directly above the user's fingertip.Please analyze or explain the text contained in this cropped region, if any.If the image contains no meaningful text, simply describe what is visible.",
        }),
      });
      
      if (!resp.ok) {
        throw new Error(`LLM API error: ${resp.status}`);
      }
      
      if (isStreaming) {
        // streaming response processing
        const reader = resp.body?.getReader();
        if (!reader) throw new Error('Failed to get streaming response');
        
        setAnswer("");
        
        // set the floating window position (next to the selection area)
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
                  console.log('[Finger Streaming] Skip invalid line:', line);
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        // non-streaming response
        const data = await resp.json();
        const content = data.content || "No response";
        
        console.log('[Finger] LLM response completed:', { contentLength: content.length });
        setAnswer(`👆 finger mode: result:\n\n${content}`);
        
        // set the floating window
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
      console.error('[Finger] Processing failed:', err);
      setAnswer(`👆 finger mode: error: ${err?.message || String(err)}`);
    } finally {
      setIsProcessing(false);
      captureLockRef.current = false;
    }
  };

  // 6) click (PointerUp is more stable) → crop ROI → OCR → call LLM
  const onPointerUp = async (e: React.PointerEvent<HTMLElement>) => {
    console.log('[Click] detected click event:', {
      pointerType: e.pointerType,
      pressure: e.pressure,
      clientX: e.clientX,
      clientY: e.clientY,
      videoReady,
      ocrReady,
      hasWorker: !!worker,
      drawingPathLength: drawingPath.length
    });
    
    // prevent repeated processing
    if (isProcessing) {
      console.log('[OCR] Already processing, skip');
      return;
    }
    setIsProcessing(true);

    // first calculate the boundary of the drawing area
    let calculatedBounds = null;
    if (drawingPath.length >= 1) {
      let bounds;
      
      // 计算笔迹的总运动距离
      let totalDistance = 0;
      for (let i = 1; i < drawingPath.length; i++) {
        const dx = drawingPath[i].x - drawingPath[i-1].x;
        const dy = drawingPath[i].y - drawingPath[i-1].y;
        totalDistance += Math.sqrt(dx * dx + dy * dy);
      }
      
      console.log('[Drawing] 笔迹分析:', {
        pointCount: drawingPath.length,
        totalDistance: totalDistance.toFixed(1),
        isShortMovement: totalDistance < 30
      });
      
      if (totalDistance < 30) {
        // 运动距离小于30px，视为单点点击
        const point = drawingPath[0];
        const defaultSize = 150; // 默认区域大小
        bounds = {
          left: Math.max(0, point.x - defaultSize/2),
          top: Math.max(0, point.y - defaultSize/2),
          width: defaultSize,
          height: defaultSize
        };
        console.log('[Drawing] 单点点击 (距离<30px)，使用默认区域:', bounds);
      } else {
        // 运动距离大，真正的绘制
        const xs = drawingPath.map(p => p.x);
        const ys = drawingPath.map(p => p.y);
        const margin = 1; // 边距
        bounds = {
          left: Math.max(0, Math.min(...xs) - margin),
          top: Math.max(0, Math.min(...ys) - margin),
          width: Math.max(...xs) - Math.min(...xs) + margin * 2,
          height: Math.max(...ys) - Math.min(...ys) + margin * 2
        };
        console.log('[Drawing] 真实绘制 (距离≥30px)，计算边界:', bounds, '总距离:', totalDistance.toFixed(1));
      }
      
      calculatedBounds = bounds;
      setSelectionBounds(bounds);
      console.log('[Drawing] ✅ Selection region set:', bounds);
    } else {
      console.log('[Drawing] ⚠️ No drawing path, clear selection region');
      setSelectionBounds(null);
    }
    
    setDebugInfo(`Click detected: ${e.pointerType} pressure:${e.pressure?.toFixed(2) || 'N/A'}`);
    
    // 不再暂停视频；Three.js实时渲染，直接从渲染canvas截取
    
    // 更新当前压力显示
    setCurrentPressure(e.pressure || 0);
    setIsUsingPen(e.pointerType === "pen");
    
    if (!videoReady) { 
      setAnswer("Video is not ready, please wait..."); 
      console.log('[Click] Video is not ready, please wait...');
      return; 
    }
    if (!ocrReady || !worker) { 
      setAnswer("OCR engine is still loading, please wait..."); 
      console.log('[Click] OCR is not ready, please wait...');
      return; 
    }

    if (!videoReady || !ocrReady || !worker) {
      console.log('[OCR] Not ready:', { videoReady, ocrReady, hasWorker: !!worker });
      return;
    } 

    const v = videoRef.current;
    const overlay = overlayRef.current;
    if (!v || !overlay) {
      console.log('[OCR] Element reference missing');
      return;
    }
    
    // 直接从overlay截图，避免复杂的坐标转换
    console.log('[OCR] Using overlay direct screenshot method');
    
    if (!calculatedBounds || calculatedBounds.width <= 5 || calculatedBounds.height <= 5) {
      setAnswer("Please use Apple Pencil to draw the area to be recognized");
      setIsProcessing(false);
      return;
    }
    
    // 创建canvas用于截图
    const canvas = document.createElement("canvas");
    canvas.width = calculatedBounds.width;
    canvas.height = calculatedBounds.height;
    const ctx = canvas.getContext("2d")!;
    
    // 图像增强函数
    const enhanceImage = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
      console.log('[Enhancement] start image enhancement processing...');
      
      // 获取图像数据
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      // 增强对比度和亮度
      for (let i = 0; i < data.length; i += 4) {
        // RGB 值
        let r = data[i];
        let g = data[i + 1];
        let b = data[i + 2];
        
        // 转换为灰度值（用于文字识别效果更好）
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        
        // 增强对比度（让文字更清晰）
        const contrast = 1.5; // 对比度增强系数
        const brightness = 20; // 亮度调整
        
        let enhanced = contrast * (gray - 128) + 128 + brightness;
        enhanced = Math.max(0, Math.min(255, enhanced));
        
        // 应用二值化处理（对文字识别很有帮助）
        const threshold = 128;
        enhanced = enhanced > threshold ? 255 : 0;
        
        // 设置增强后的值
        data[i] = enhanced;     // R
        data[i + 1] = enhanced; // G  
        data[i + 2] = enhanced; // B
        // Alpha 通道保持不变
      }
      
      // 将处理后的数据写回canvas
      ctx.putImageData(imageData, 0, 0);
      console.log('[Enhancement] ✅ Image enhancement completed (contrast + binarization)');
    };
    
    console.log('[Click] Start direct screenshot from overlay...', {
      canvasSize: { width: canvas.width, height: canvas.height },
      selectionBounds: calculatedBounds
    });

    try {
   
        // method: use getDisplayMedia API or directly screenshot from the DOM
        // but the simplest method is to create a temporary canvas to draw the entire overlay, then crop
      
      console.log('[Screenshot] Start capturing overlay area...');
      
            // get various size information for debugging
      const overlayRect = overlay.getBoundingClientRect();
      const videoRect = v.getBoundingClientRect();
      const videoNaturalSize = { width: v.videoWidth, height: v.videoHeight };
      const containerSize = { width: 500, height: 500 }; 
      
     
      
      // create a temporary canvas to draw the entire overlay content
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = overlayRect.width;
      tempCanvas.height = overlayRect.height;
      const tempCtx = tempCanvas.getContext("2d")!;
      
      console.log('[Debug] Temporary canvas size:', { width: tempCanvas.width, height: tempCanvas.height });
      
      // draw the video to the temporary canvas (including all transformations)
      tempCtx.save();
      
      console.log('[Debug] Start applying transformations...');
      
      // apply the same transformations as the video
      tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
      console.log('[Debug] 1. Move to center:', tempCanvas.width / 2, tempCanvas.height / 2);
      
      tempCtx.scale(-1, 1); // horizontal flip
      console.log('[Debug] 2. Horizontal flip');
      
      tempCtx.scale(videoScale, videoScale); // scale
      console.log('[Debug] 3. Scale:', videoScale);
      
      tempCtx.translate(videoTranslate.x, videoTranslate.y); // translate
      console.log('[Debug] 4. Translate:', videoTranslate.x, videoTranslate.y);
      
      tempCtx.translate(-tempCanvas.width / 2, -tempCanvas.height / 2);
     
      
      // draw the video, keeping the original aspect ratio
      const videoAspect = v.videoWidth / v.videoHeight;
      const canvasAspect = tempCanvas.width / tempCanvas.height;
      
      let drawWidth, drawHeight, drawX, drawY;
      
      if (videoAspect > canvasAspect) {
        // video is wider, take the width as the basis
        drawWidth = tempCanvas.width;
        drawHeight = tempCanvas.width / videoAspect;
        drawX = 0;
        drawY = (tempCanvas.height - drawHeight) / 2;
      } else {
        // video is higher, take the height as the basis
        drawHeight = tempCanvas.height;
        drawWidth = tempCanvas.height * videoAspect;
        drawX = (tempCanvas.width - drawWidth) / 2;
        drawY = 0;
      }
      
     
      
      tempCtx.drawImage(v, drawX, drawY, drawWidth, drawHeight);
      tempCtx.restore();
      
      
      
      // check if the extracted area is out of bounds
      const safeLeft = Math.max(0, Math.min(calculatedBounds.left, tempCanvas.width - 1));
      const safeTop = Math.max(0, Math.min(calculatedBounds.top, tempCanvas.height - 1));
      const safeWidth = Math.min(calculatedBounds.width, tempCanvas.width - safeLeft);
      const safeHeight = Math.min(calculatedBounds.height, tempCanvas.height - safeTop);
      
    
      
      const selectionImageData = tempCtx.getImageData(
        safeLeft, 
        safeTop, 
        safeWidth, 
        safeHeight
      );
      
      
      
      // draw the extracted area to the final canvas
      ctx.putImageData(selectionImageData, 0, 0);
      
        
      // additional debugging: save the temporary canvas for inspection
      const tempDataURL = tempCanvas.toDataURL();
      console.log('[Debug] temporary canvas content length:', tempDataURL.length);
      console.log('[Debug] you can copy this URL to the browser console to view the temporary canvas content:');
      console.log(tempDataURL.substring(0, 100) + '...');
      
      // check if the canvas really has content
      const imageData = ctx.getImageData(0, 0, Math.min(10, canvas.width), Math.min(10, canvas.height));
      const hasContent = imageData.data.some(pixel => pixel !== 0);
     
      
      if (!hasContent) {
        console.error('[Click] Canvas is empty! Try iPad fallback capture method...');
        
        // iPad fallback method: try different drawing parameters
        try {
          // method 1: ensure the video is fully loaded
          if (v.readyState < 2) {
            setAnswer("Error: Video not fully loaded, please wait for video to be ready");
            setCapturedImage("");
            return;
          }
          
          // method 2: try drawing the entire video then cropping
          const tempCanvas = document.createElement("canvas");
          tempCanvas.width = v.videoWidth;
          tempCanvas.height = v.videoHeight;
          const tempCtx = tempCanvas.getContext("2d")!;
          
          // draw the entire video frame
          tempCtx.drawImage(v, 0, 0);
          
          // check if the entire video frame has content
          const fullImageData = tempCtx.getImageData(0, 0, Math.min(10, v.videoWidth), Math.min(10, v.videoHeight));
          const fullHasContent = fullImageData.data.some(pixel => pixel !== 0);
          
          if (!fullHasContent) {
            setAnswer("Error: No pixel data from video on iPad, possibly Safari security restrictions");
            setCapturedImage("");
            return;
          }
          
          // extract the ROI from the full video frame
          const roiImageData = tempCtx.getImageData(
            calculatedBounds.left, calculatedBounds.top, 
            calculatedBounds.width, calculatedBounds.height
          );
          ctx.putImageData(roiImageData, 0, 0);
          
          console.log('[Click] iPad fallback capture successful');
          
        } catch (fallbackError: any) {
          console.error('[Click] iPad fallback capture also failed:', fallbackError);
          setAnswer(`Error: All video capture methods failed - ${fallbackError.message || String(fallbackError)}`);
          setCapturedImage("");
          return;
        }
      }
      
    } catch (drawError: any) {
      console.error('[Click] Error drawing video frame to canvas:', drawError);
      setAnswer(`Error: Failed to draw video frame to canvas - ${drawError.message || String(drawError)}`);
      setCapturedImage("");
      return;
    }

    console.log('[Click] Canvas created, starting OCR...', {
      canvasSize: { width: canvas.width, height: canvas.height },
      selectionBounds: calculatedBounds,
      videoSize: { width: v.videoWidth, height: v.videoHeight }
    });

      // WYSIWYG: crop from the Three.js rendering canvas
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
      console.log('[Click] WYSIWYG screenshot successful, length:', imageDataUrl.length);
    } catch (e: any) {
      console.error('[Click] DataURL failed:', e);
      setIsProcessing(false);
      return;
    }
    
    // decide whether to perform image enhancement based on the settings
    if (isEnhancementEnabled) {
      const ctx = cropSource.getContext('2d')!;
      enhanceImage(cropSource, ctx);
      console.log('[Enhancement] ✅ Image enhancement applied');
    } else {
      console.log('[Enhancement] ⚪ Image enhancement disabled');
    }
    
    // get the processed image for display
    setTimeout(() => {
      try { setCapturedImage(imageDataUrl); } catch {}
    }, 0);
    
    console.log('[Enhancement] Image enhancement completed, starting OCR recognition...');

    try {
      const { data: { text } } = await worker.recognize(cropSource);
      const picked = text.trim().slice(0, 400);
      console.log('[OCR] Recognition result:', { 
        originalLength: text.length, 
        trimmedLength: picked.length, 
        text: picked 
      });
      
      setAnswer(`calling LLM... (pressure level: ${level})\n\nrecognized text: ${picked || "(no text detected)"}`);
      setDebugInfo(`pressure level: ${level})\n\nrecognized text: ${picked || "(no text detected)"}`);
      if(picked.length === 0) {
        setAnswer("no text detected");
        console.log('[OCR] Text is empty, possible reasons: image quality, lighting, angle, or the area确实没有文字');
        return;
      }

      // call LLM
      const resp = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: picked || "No text", level, image: imageDataUrl, streaming: isStreaming }),
      });

      console.log('[LLM] API call status:', resp.status);

      if (!resp.ok) {
        throw new Error(`LLM API error: ${resp.status}`);
      }

      if (isStreaming) {
        // Handle streaming response
        const reader = resp.body?.getReader();
        if (!reader) {
          throw new Error('Failed to get streaming response');
        }

        setAnswer(""); // Clear previous answer
        
        // initialize the floating window position
        if (calculatedBounds) {
          const containerWidth = 500;
          const floatingWidth = 240;
          
          let floatingX, floatingY;
          
          // get the position of the video container in the page
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
                    
                    // update the floating window content
                    if (calculatedBounds) {
                      setFloatingResponse(prev => prev ? {
                        ...prev,
                        text: streamingText
                      } : null);
                    }
                  }
                } catch (e) {
                  console.log('[Streaming] Skip invalid line:', line);
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
        
        console.log('[LLM] Response completed:', { contentLength: content.length });
        setAnswer(content);
        
        // set the floating window position (next to the selection box)
        if (calculatedBounds) {
          const containerWidth = 500; // video container width
          const floatingWidth = 240; // floating window approximately width
          
          // smart position: display above the selection box
          let floatingX, floatingY;
          
          // Get the position of the video container in the page
          const videoContainer = document.querySelector('.video-container');
          const containerRect = videoContainer?.getBoundingClientRect();
          
          if (containerRect) {
            // X coordinate: absolute position relative to the page
            floatingX = containerRect.left + calculatedBounds.left + calculatedBounds.width / 2;
            
            // Y coordinate: absolute position relative to the page, display above the selection box
            floatingY = containerRect.top + calculatedBounds.top - 10;
          } else {
            // Backup solution
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
   
      <h1 className="text-xl font-semibold mb-3 text-gray-600">PressureLens — Web</h1>

      <div className="mb-2 text-sm text-gray-600">
        Video: {videoReady ? "✅ ready" : "⏳ loading"} ·
        OCR: {ocrReady ? "✅ ready" : "⏳ loading"} ·
        Level: <b className={
          level==="light" ? "text-green-600" :
          level==="medium" ? "text-amber-600" : "text-red-600"
        }>{level}</b>
        {isUsingPen && currentPressure > 0 && (
          <span className="ml-2 text-blue-600">
            ✏️ Apple Pencil pressure: <b>{currentPressure.toFixed(3)}{drawingPath.length}</b>
          </span>
        )}
        {debugInfo && <div className="mt-1 text-xs text-blue-600">🔍 {debugInfo}</div>}
        {/* {deviceInfo && <div className="mt-1 text-xs text-purple-600">📱 {deviceInfo}</div>} */}
      </div>

      {/* data collection switch & simple statistics */}
      {/* <div className="mb-3 flex flex-wrap gap-3 items-center text-sm">
        <div className="flex items-center gap-2">
          <span className="text-gray-600">data logging:</span>
          <button
            onClick={() => setIsLoggingEnabled((v) => !v)}
            className={`px-3 py-1 rounded text-sm transition-colors ${
              isLoggingEnabled ? "bg-emerald-500 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            {isLoggingEnabled ? "✅ on" : "⏸️ off"}
          </button>
        </div>
        <div className="text-xs text-gray-600">
          {(() => {
            const s = sessionLogger.getSummary();
            return (
              <>
                samples: <span className="font-semibold">{s.pointerSamples}</span> ·
                voice: <span className="font-semibold ml-1">{s.voiceAnnotations}</span> ·
                selected topics: <span className="font-semibold ml-1">{s.selectedTopics}</span> ·
                page topics: <span className="font-semibold ml-1">{s.hasPageOcr ? "yes" : "no"}</span>
              </>
            );
          })()}
        </div>
        <button
          onClick={() => sessionLogger.exportJson(deviceInfo)}
          className="ml-auto px-3 py-1 rounded text-xs bg-black text-white hover:bg-gray-900"
        >
          download session JSON
        </button>
        <div className="w-full sm:w-auto">
          <VoiceTopicRecorder
            onAnnotation={(ann) => {
              sessionLogger.addVoiceAnnotation(ann);
              setLastVoiceAnnotation(ann);
              // Also record the voice content as a "selected topic"
              if (ann.transcript && ann.transcript.trim()) {
                sessionLogger.addSelectedTopic({
                  id: `voice-topic-${ann.timestampStart}-${Math.random().toString(36).slice(2, 6)}`,
                  timestamp: ann.timestampEnd,
                  text: ann.transcript.trim(),
                  source: "voice",
                });
                setLastSelectedTopic(ann.transcript.trim());
                setTimeout(() => setLastSelectedTopic(null), 1500);
              }
            }}
          />
        </div>
      </div> */}

      

      {/* pressure bar display */}
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
                transition: 'none' // remove the transition animation, achieve real-time response
              }}
            />
            <div className="absolute inset-0 flex items-center justify-center text-xs font-medium text-white mix-blend-difference">
              {isPressed ? (currentPressure * 100).toFixed(0) : 0}%
            </div>
            {/* pressure level boundaries */}
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

      {/* input mode switch */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">input mode:</span>
        <button
          onClick={() => {
            setHandDetectionMode('pencil');
            setIsHandDetectionEnabled(false);
            setFingerTipPosition(null);
          
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


      {/* finger long-press auto call LLM switch */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">finger long-press LLM:</span>
        <button
          onClick={() => setIsFingerLongPressLLMEnabled((v) => !v)}
          className={`px-3 py-1 rounded text-sm transition-colors ${
            isFingerLongPressLLMEnabled
              ? "bg-blue-500 text-white"
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

  

      

      
      <div className="mb-3 flex gap-2">
        <span className="text-sm text-gray-600">pressure level:</span>
        {(['light', 'medium', 'hard'] as Level[]).map((l) => {
          // if pressed, display currentMaxLevel; otherwise display the set level
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

      {/* streaming mode switch */}
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
          {isStreaming ? 'streaming' : 'no streaming'}
        </button>
      </div>

    
      {/* line spacing compensation (three levels) */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">vertical compensation:</span>
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
                  // setDebugInfo(`🔧 warp: ${i===0?'0':i===1?'0.18':'0.5'} (${val.toFixed(2)})`);
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

      {/* perspective strength control */}
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
              setDebugInfo(`🔄 perspective strength: ${value}% (${(value * 0.3).toFixed(1)}degrees)`);
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
       {/* test button */}
       <div className="mt-4 flex gap-2 flex-wrap">
        {/* <button
          onClick={() => {
            setDebugInfo('');
            setAnswer('');
            setFloatingResponse(null); // 
          }}
          className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 text-sm"
        >
          clear
        </button> */}
        
 
        <button
          onClick={() => {
            const video = videoRef.current;
            if (video && !video.paused) {
              video.pause();
              setIsVideoFrozen(true);
              setDebugInfo('⏸ image frozen');
            }
          }}
          className="px-4 py-2 bg-yellow-500 text-white rounded hover:bg-yellow-600 text-sm"
        >
          ⏸ freeze image
        </button>


        {/* <button
          onClick={() => {
            setVideoScale(1);
            setVideoTranslate({x: 0, y: 0});
            setPerspectiveStrength(0);
            setDebugInfo('🔄 reset');
          }}
          className="px-4 py-2 bg-indigo-500 text-white rounded hover:bg-indigo-600 text-sm"
        >
          🔄 reset
        </button> */}
        
   
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
                setDebugInfo('▶️ image resumed');
              }
            }}
            className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 text-sm"
          >
            ▶️ resume
          </button>
        )}
      </div>

              <div 
         className="video-container relative overflow-hidden border rounded-xl bg-black"
         style={{
           width: '500px',
           height: '500px',
           touchAction: 'pan-x pan-y pinch-zoom' // allow pan and zoom
         }}
        >
          {/* hidden video element (only used as the Three.js texture source) */}
          <video 
            ref={videoRef} 
            className="video-element" 
            playsInline 
            style={{
              display: 'none' // hide the native video, use Three.js rendering
            }}
          />
          
          {/* Three.js rendering canvas (display real-time 3D effect) */}
          <canvas
            ref={threeCanvasRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '500px',
              height: '500px',
              pointerEvents: 'none' // do not receive events, handled by the overlay
            }}
          />
        {/* OCR overlay layer (only draw word boxes) */}
        <canvas
          ref={ocrOverlayCanvasRef}
          className="absolute inset-0 pointer-events-none"
          style={{ width: '500px', height: '500px' }}
        />
        {/* overlay on the video to receive gesture events */}
        <div
          ref={overlayRef}
          onPointerUp={(e) => {
            // only Apple Pencil triggers OCR
            if (e.pointerType === "pen") {
              console.log('[Events] Apple Pencil PointerUp - trigger OCR');
              onPointerUp(e);
            } else {
              console.log('[Events] Non-Apple Pencil event, skip OCR:', e.pointerType);
            }
          }}
          onPointerDown={(e) => {
            // if the floating window is being dragged, do not handle other gestures
            if (isDraggingFloat) return;
            
            console.log('[Events] PointerDown:', {
              type: e.pointerType,
              pressure: e.pressure,
              x: e.clientX,
              y: e.clientY,
              isPrimary: e.isPrimary
            });
            
            if (e.pointerType === "pen") {
              // Apple Pencil - only used for drawing, not for dragging
              console.log('[Pencil] Apple Pencil down, prepare drawing');
              setDebugInfo(`✏️ Apple Pencil: pressure:${e.pressure?.toFixed(2) || 'N/A'}`);
            } else if (e.pointerType === "touch") {
              // finger - used for zooming and dragging
              console.log('[Finger] finger down, prepare gesture operation');
              (e.currentTarget as any).lastPointerX = e.clientX;
              (e.currentTarget as any).lastPointerY = e.clientY;
              (e.currentTarget as any).initialTranslate = {...videoTranslate};
              (e.currentTarget as any).fingerPointerId = e.pointerId;
              setDebugInfo(`👆 finger down: (${e.clientX.toFixed(0)}, ${e.clientY.toFixed(0)})`);
            }
          }}
          onTouchStart={(e) => {
            if (e.touches.length === 2) {
              // double finger zoom start (only fingers can produce double finger touch)
              const touch1 = e.touches[0];
              const touch2 = e.touches[1];
              const distance = Math.sqrt(
                Math.pow(touch2.clientX - touch1.clientX, 2) + 
                Math.pow(touch2.clientY - touch1.clientY, 2)
              );
              (e.currentTarget as any).initialDistance = distance;
              (e.currentTarget as any).initialScale = videoScale;
              console.log('[Zoom] double finger zoom start:', { distance, currentScale: videoScale });
              setDebugInfo(`🔍 zoom start (${distance.toFixed(0)}px)`);
            }
          }}
          onPointerMove={(e) => {
            // if the floating window is being dragged, do not handle other gestures
            if (isDraggingFloat) return;
            
            if (e.pointerType === "pen") {
                // Apple Pencil - only handle drawing, not for dragging
              return;
            } else if (e.pointerType === "touch") {
              // finger dragging handling (only allowed when zooming)
              const fingerPointerId = (e.currentTarget as any).fingerPointerId;
              const lastX = (e.currentTarget as any).lastPointerX;
              const lastY = (e.currentTarget as any).lastPointerY;
              const initialTranslate = (e.currentTarget as any).initialTranslate;
              
              if (e.pointerId === fingerPointerId && lastX !== undefined && lastY !== undefined && initialTranslate && videoScale > 1) {
                const deltaX = e.clientX - lastX;
                const deltaY = e.clientY - lastY;
                
                // due to the horizontal flip of the video, the X direction needs to be reversed
                setVideoTranslate({
                  x: initialTranslate.x - deltaX / videoScale, // note that this is a minus sign
                  y: initialTranslate.y + deltaY / videoScale
                });
                setDebugInfo(`📱 finger drag: (${deltaX.toFixed(0)}, ${deltaY.toFixed(0)}) zoom:${(videoScale * 100).toFixed(0)}%`);
              }
            }
          }}
          onTouchMove={(e) => {
            e.preventDefault(); // prevent page scrolling
            
            if (e.touches.length === 2) {
              // double finger zoom (only fingers can trigger, Apple Pencil does not produce multi-touch)
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
                setDebugInfo(`🔍 zoom: ${(newScale * 100).toFixed(0)}%`);
                console.log('[Zoom] double finger zoom:', newScale);
              }
            }
            // remove single finger dragging handling, use PointerMove instead
          }}
          onTouchEnd={(e) => {
            if (e.touches.length === 0) {
              // all fingers leave
              setDebugInfo(`✅ zoom: ${(videoScale * 100).toFixed(0)}%`);
            }
          }}
          className="absolute inset-0 z-10 cursor-crosshair select-none"
          style={{ 
            touchAction: 'none', // disable default touch behavior, completely custom
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
            WebkitTapHighlightColor: 'transparent',
            pointerEvents: 'auto' // ensure the pointer event can be triggered
          }}
          title="Use Apple Pencil to select the region"
        >
          {/* finger detection mode visual feedback */}
          {handDetectionMode === 'finger' && fingerTipPosition && (
            <>
              {/* finger tip marker (always show) */}
              <div
                className="absolute w-3 h-3 bg-red-500 rounded-full pointer-events-none border-2 border-white shadow-lg z-20"
                style={{
                  left: `${fingerTipPosition.x - 8}px`,
                  top: `${fingerTipPosition.y - 8}px`,
                  animation: isFingerLongPressLLMEnabled && longPressState.isActive ? 'none' : 'pulse 2s infinite'
                }}
              />

                {/* nearest OCR word debug label */}
              {debugNearestWord && (
                <div
                  className="absolute pointer-events-none z-30 bg-black bg-opacity-75 text-white text-xs px-2 py-1 rounded shadow-lg"
                  style={{
                    left: `${fingerTipPosition.x + 16}px`,
                    top: `${fingerTipPosition.y - 24}px`,
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
              
              {/* long press progress ring (only show when finger long-press LLM is enabled) */}
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
                    {/* background ring */}
                    <circle
                      cx="25"
                      cy="25"
                      r="20"
                      stroke="rgba(255,255,255,0.3)"
                      strokeWidth="3"
                      fill="none"
                    />
                    {/* progress ring */}
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
                  
                  {/* center level indicator */}
                  <div
                    className="absolute inset-0 flex items-center justify-center text-white text-xs font-bold"
                    style={{
                      textShadow: '0 0 4px rgba(0,0,0,0.8)'
                    }}
                  >
                    {longPressState.currentLevel === 'hard' ? 'H' :
                     longPressState.currentLevel === 'medium' ? 'M' : 'L'}
                  </div>
                  
                    {/* time display and hint */}
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
              
              {/* preview selection area (only show when finger long-press LLM is enabled) */}
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
                    {/* area label */}
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
                        `selection area ${previewArea.width}×${previewArea.height}`
                      }
                    </div>
                  </div>
                );
              })()}
            </>
          )}



          {/* Apple Pencil drawing path visualization */}
          {handDetectionMode === 'pencil' && drawingPath.length > 1 && (() => {
            // calculate the movement distance
            let distance = 0;
            for (let i = 1; i < drawingPath.length; i++) {
              const dx = drawingPath[i].x - drawingPath[i-1].x;
              const dy = drawingPath[i].y - drawingPath[i-1].y;
              distance += Math.sqrt(dx * dx + dy * dy);
            }
            
            // only show the path line if the movement distance is greater than 15px
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
          
          {/* Apple Pencil current drawing point display */}
          {handDetectionMode === 'pencil' && isPressed && drawingPath.length > 0 && (
            <div
              className="absolute w-2 h-2 bg-blue-500 rounded-full pointer-events-none"
              style={{
                left: `${drawingPath[drawingPath.length - 1].x - 4}px`,
                top: `${drawingPath[drawingPath.length - 1].y - 4}px`
              }}
            />
          )}
          
          {/* selection area boundary visualization */}
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
          
        </div>
        
        {/* floating window response - move to the video container outer layer, avoid being blocked by the border */}
        {floatingResponse && (
          <div
            className="fixed z-50 select-none"
            style={{
              left: `${floatingResponse.position.x}px`,
              top: `${floatingResponse.position.y}px`,
              transform: 'translate(-50%, -100%)', // horizontal center, vertical upward offset
              pointerEvents: 'auto', // allow interaction
              width: '240px', // fixed width, prevent change when dragging
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
              }
            }}
            onPointerLeave={() => {
              if (isDraggingFloat) {
                setIsDraggingFloat(false);
              }
            }}
          >
            <div className="bg-black bg-opacity-90 text-white text-xs rounded-lg shadow-xl backdrop-blur-sm border border-gray-600">
              {/* title bar and close button (drag handle) */}
              <div className="drag-handle flex justify-between items-center p-2 pb-1 cursor-move border-b border-gray-600">
                <div className="text-gray-300 text-xs">AI Response</div>
                <button
                  onClick={() => {
                    setFloatingResponse(null);
                  }}
                  className="text-gray-400 hover:text-white transition-colors w-4 h-4 flex items-center justify-center rounded hover:bg-gray-700"
                  title="close"
                >
                  ×
                </button>
              </div>
              
              {/* content area */}
              <div className="p-2 pt-1">
                <div className="whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {floatingResponse.text || "analyzing..."}
                </div>
              </div>
              
              {/* small arrow pointing to the selection box below */}
              <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-black bg-opacity-90 rotate-45 border-r border-b border-gray-600"></div>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 p-3 rounded-lg border bg-white max-w-md whitespace-pre-wrap text-sm text-gray-600">
        <div className="font-medium mb-1">Response</div>
        {answer || "Tap the video to OCR the region under your pen, then call LLM."}
      </div>

      {/* main page: OCR operation in the visible region */}
      {/* <div className="mt-4 flex gap-2 flex-wrap">
        <button
          onClick={runRegionOCR}
          className="px-3 py-2 rounded-md text-white disabled:opacity-50"
          style={{ background: '#111827' }}
        >
          OCR Region (Whole Frame)
        </button>
        <button
          onClick={clearRegionOCR}
          disabled={!ocrWordsInRegion}
          className="px-3 py-2 rounded-md border disabled:opacity-50"
        >
          Clear OCR Region
        </button>
      </div> */}

      {/* Region OCR debug: only show the image and recognized text when the OCR Region button is triggered */}
      {(regionCapturedImage || regionRecognizedText) && (
        <div className="mt-2 p-3 rounded-lg border bg-white max-w-md">
          <div className="font-medium mb-2">🧪 Region OCR Debug</div>
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
          {regionTopics && regionTopics.length > 0 && (
            <div className="mt-2 text-xs text-gray-800">
              <div className="font-medium mb-1">Topics (LLM JSON for recommender):</div>
              <div className="flex flex-wrap gap-2 mt-1">
                {regionTopics.map((t, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      const id = `topic-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
                      sessionLogger.addSelectedTopic({
                        id,
                        timestamp: Date.now(),
                        text: t.text,
                        source: "page_topic",
                      });
                      setLastSelectedTopic(t.text);
                      setTimeout(() => setLastSelectedTopic(null), 1500);
                    }}
                    className="px-2 py-1 rounded border border-gray-300 bg-gray-50 hover:bg-gray-100 text-[11px]"
                  >
                    <span className="font-semibold">{t.text}</span>
                    {typeof t.weight === "number" && (
                      <span className="ml-1 text-gray-500">
                        ({t.weight.toFixed(2)})
                      </span>
                    )}
                    {t.category && (
                      <span className="ml-1 text-gray-400">
                        [{t.category}]
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* display the captured image */}
      {capturedImage && (
        <div className="mt-4 p-3 rounded-lg border bg-white max-w-md">
          <div className="font-medium mb-2">📸 Captured Image (for OCR)</div>
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
              ROI: {selectionBounds.width.toFixed(0)}×{selectionBounds.height.toFixed(0)}px 
              (x: {selectionBounds.left.toFixed(0)}, y: {selectionBounds.top.toFixed(0)})
            </div>
          )}
        </div>
      )}

      {/* topic selection toast */}
      {lastSelectedTopic && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
          <div className="px-3 py-2 rounded-full bg-black bg-opacity-80 text-white text-xs shadow-lg">
            topic selected: <span className="font-semibold">{lastSelectedTopic}</span>selected
          </div>
        </div>
      )}

     
    </main>
  );
}
