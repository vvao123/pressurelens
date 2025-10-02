"use client";
import { useEffect, useRef, useState } from "react";
import { createWorker, Worker } from "tesseract.js";

type Level = "light" | "medium" | "hard";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  
  // 长按检测的ref，避免频繁setState
  const longPressRef = useRef({
    startTime: 0,
    startPosition: null as {x: number, y: number} | null,
    currentLevel: 'light' as Level,
    hasTriggered: false,
    hasScreenshot: false // 是否已经截屏
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
  const [isPressed, setIsPressed] = useState<boolean>(false); // 是否正在按压
  const [isVideoFrozen, setIsVideoFrozen] = useState<boolean>(false); // 视频是否被冻结
  const [drawingPath, setDrawingPath] = useState<{x: number, y: number}[]>([]); // 绘制路径
  const [selectionBounds, setSelectionBounds] = useState<{left: number, top: number, width: number, height: number} | null>(null); // 选择区域边界
  const [isStreaming, setIsStreaming] = useState<boolean>(false); // 是否启用流式显示
  const [isProcessing, setIsProcessing] = useState<boolean>(false); // 防止重复处理
  const [isEnhancementEnabled, setIsEnhancementEnabled] = useState<boolean>(false); // 是否启用图像增强
  const [videoScale, setVideoScale] = useState<number>(1); // 视频缩放比例
  const [videoTranslate, setVideoTranslate] = useState<{x: number, y: number}>({x: 0, y: 0}); // 视频平移位置
  const [floatingResponse, setFloatingResponse] = useState<{text: string, position: {x: number, y: number}} | null>(null); // 浮窗响应
  const [isDraggingFloat, setIsDraggingFloat] = useState<boolean>(false); // 是否正在拖拽浮窗
  const [perspectiveStrength, setPerspectiveStrength] = useState<number>(0); // 透视强度 0-100

  // 手指检测相关状态
  const [handResults, setHandResults] = useState<any>(null); // MediaPipe 检测结果
  const [fingerTipPosition, setFingerTipPosition] = useState<{x: number, y: number} | null>(null); // 指尖位置
  const [isHandDetectionEnabled, setIsHandDetectionEnabled] = useState<boolean>(false); // 是否启用手指检测
  const [handDetectionMode, setHandDetectionMode] = useState<'pencil' | 'finger'>('pencil'); // 输入模式
  const [handsInstance, setHandsInstance] = useState<any>(null); // MediaPipe Hands 实例
  
  // 长按检测相关状态（只保留UI需要的字段）
  const [longPressState, setLongPressState] = useState<{
    isActive: boolean;
    currentDuration: number;
    currentLevel: Level;
    shouldTriggerOnMove: Level | false; // 标记应该触发的级别，false表示不触发
  }>({
    isActive: false,
    currentDuration: 0,
    currentLevel: 'light',
    shouldTriggerOnMove: false
  });
  
  // 手指检测配置参数
  const [handDetectionConfig, setHandDetectionConfig] = useState({
    minDetectionConfidence: 0.8,
    minTrackingConfidence: 0.8,
    modelComplexity: 1
  });

  // 长按配置参数
  const longPressConfig = {
    positionTolerance: 15, // 位置容差（像素）
    lightThreshold: 1800,   // light级别阈值（毫秒）
    mediumThreshold: 3000, // medium级别阈值（毫秒）
    hardThreshold: 5500,   // hard级别阈值（毫秒）
    autoTriggerDelay: 1800  // 自动触发延迟（毫秒）
  };

  // 检测设备信息
  useEffect(() => {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isIPad = /iPad/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
    const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua);
    
    const info = `device: ${isIPad ? 'iPad' : isIOS ? 'iPhone' : 'other'} | browser: ${isSafari ? 'Safari' : 'other'} | touch points: ${navigator.maxTouchPoints}`;
    setDeviceInfo(info);
    console.log('[Device]', info);
  }, []);

  // 添加移动端调试工具
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
            // 添加更多约束以获得更好的画质
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
            
            // 尝试设置自动对焦
            try {
              const videoTrack = stream.getVideoTracks()[0];
              const capabilities = videoTrack.getCapabilities() as any;
              console.log('[Camera] 摄像头能力:', capabilities);
              
              // 如果支持对焦，设置为连续自动对焦
              if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
                await videoTrack.applyConstraints({
                  advanced: [{ focusMode: 'continuous' } as any]
                });
                console.log('[Camera] ✅ 已启用连续自动对焦');
              } else if (capabilities.focusMode && capabilities.focusMode.includes('single-shot')) {
                await videoTrack.applyConstraints({
                  advanced: [{ focusMode: 'single-shot' } as any]
                });
                console.log('[Camera] ✅ 已启用单次自动对焦');
              } else {
                console.log('[Camera] ⚠️ 设备不支持自动对焦控制，尝试手动对焦...');
                
                // 如果支持手动对焦距离设置
                if (capabilities.focusDistance) {
                  // 设置一个中等对焦距离（通常对文档阅读比较好）
                  const midDistance = (capabilities.focusDistance.min + capabilities.focusDistance.max) / 2;
                  await videoTrack.applyConstraints({
                    advanced: [{ focusDistance: midDistance } as any]
                  });
                  console.log('[Camera] ✅ 已设置手动对焦距离:', midDistance);
                } else {
                  console.log('[Camera] ⚠️ 设备不支持任何对焦控制');
                }
              }
              
              // 如果支持白平衡，设置为自动
              if (capabilities.whiteBalanceMode && capabilities.whiteBalanceMode.includes('continuous')) {
                await videoTrack.applyConstraints({
                  advanced: [{ whiteBalanceMode: 'continuous' } as any]
                });
                console.log('[Camera] ✅ 已启用自动白平衡');
              }
              
              // 如果支持曝光，设置为自动
              if (capabilities.exposureMode && capabilities.exposureMode.includes('continuous')) {
                await videoTrack.applyConstraints({
                  advanced: [{ exposureMode: 'continuous' } as any]
                });
                console.log('[Camera] ✅ 已启用自动曝光');
              }
              
            } catch (constraintError) {
              console.warn('[Camera] 设置摄像头约束失败:', constraintError);
            }
            
            setVideoReady(true);
          } catch (e) {
            console.error("play() failed", e);
          }
        };
      } catch (e) {
        console.error("Camera error", e);
      }
    })();
  }, []);

  // 2) initialize OCR
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        console.log('[OCR] start initializing Tesseract.js...');
        
        // v5+ 的正确用法：直接传语言代码，不需要额外配置
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

  // 3) MediaPipe Hands 实例创建/销毁（只依赖启用状态）
  useEffect(() => {
    if (!isHandDetectionEnabled) {
      // 清理现有实例
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
        console.log('[HandDetection] 开始初始化 MediaPipe Hands...');
        
        // 使用CDN方式加载MediaPipe Hands
        if (!(window as any).Hands) {
          // 动态加载MediaPipe脚本
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js';
          
          await new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
          });
          
          console.log('[HandDetection] MediaPipe脚本加载完成');
        }
        
        if (!mounted) return;
        
        const hands = new (window as any).Hands({
          locateFile: (file: string) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
          }
        });
        
        hands.setOptions({
          maxNumHands: 1, // 只检测一只手
          modelComplexity: handDetectionConfig.modelComplexity, // 使用配置的模型复杂度
          minDetectionConfidence: handDetectionConfig.minDetectionConfidence, // 使用配置的检测置信度
          minTrackingConfidence: handDetectionConfig.minTrackingConfidence,  // 使用配置的跟踪置信度
          selfieMode: false, // 不使用自拍模式（避免额外的镜像处理）
          staticImageMode: false // 使用视频模式而非静态图像模式
        });
        
        hands.onResults((results: any) => {
          if (!mounted) return;
          
          setHandResults(results);
          
          if (results.multiHandLandmarks && results.multiHandLandmarks[0]) {
            const landmarks = results.multiHandLandmarks[0];
            // 获取食指指尖坐标 (landmark 8)
            const fingerTip = landmarks[8];
            
            // 转换为像素坐标（考虑视频实际显示区域）
            const videoContainer = document.querySelector('.video-container') as HTMLElement;
            const video = videoRef.current;
            if (videoContainer && video) {
              const containerRect = videoContainer.getBoundingClientRect();
              
              // 关键：计算视频在容器中的实际显示区域
              const videoAspect = video.videoWidth / video.videoHeight;
              const containerAspect = containerRect.width / containerRect.height;
              
              let videoDisplayWidth, videoDisplayHeight, videoOffsetX, videoOffsetY;
              
              if (videoAspect > containerAspect) {
                // 视频更宽，以容器宽度为准
                videoDisplayWidth = containerRect.width;
                videoDisplayHeight = containerRect.width / videoAspect;
                videoOffsetX = 0;
                videoOffsetY = (containerRect.height - videoDisplayHeight) / 2;
              } else {
                // 视频更高，以容器高度为准
                videoDisplayHeight = containerRect.height;
                videoDisplayWidth = containerRect.height * videoAspect;
                videoOffsetX = (containerRect.width - videoDisplayWidth) / 2;
                videoOffsetY = 0;
              }
              
              // 1. 基于实际视频显示区域的坐标转换（镜像修正）
              let x = (1 - fingerTip.x) * videoDisplayWidth + videoOffsetX;
              let y = fingerTip.y * videoDisplayHeight + videoOffsetY;
              
              // 2. 考虑视频变换（缩放和平移）
              // 变换是相对于容器中心的
              const centerX = containerRect.width / 2;
              const centerY = containerRect.height / 2;
              
              // 将坐标转换为相对于中心的坐标
              let relativeX = x - centerX;
              let relativeY = y - centerY;
              
              // 应用视频的变换（缩放和平移）
              relativeX = relativeX * videoScale + videoTranslate.x;
              relativeY = relativeY * videoScale + videoTranslate.y;
              
              // 转换回绝对坐标
              x = relativeX + centerX;
              y = relativeY + centerY;
              
              setFingerTipPosition({ x, y });
              
              // 长按检测逻辑（使用ref减少setState）
              const currentTime = Date.now();
              const newPosition = { x, y };
              
              // 检查是否在同一位置（容差范围内）
              if (longPressRef.current.startPosition) {
                const distance = Math.sqrt(
                  Math.pow(newPosition.x - longPressRef.current.startPosition.x, 2) + 
                  Math.pow(newPosition.y - longPressRef.current.startPosition.y, 2)
                );
                
                if (distance <= longPressConfig.positionTolerance) {
                  // 在同一位置，更新持续时间
                  const duration = currentTime - longPressRef.current.startTime;
                  let currentLevel: Level = 'light';
                  
                  if (duration >= longPressConfig.hardThreshold) {
                    currentLevel = 'hard';
                  } else if (duration >= longPressConfig.mediumThreshold) {
                    currentLevel = 'medium';
                  } else if (duration >= longPressConfig.lightThreshold) {
                    currentLevel = 'light';
                  }
                  
                  // 更新ref
                  longPressRef.current.currentLevel = currentLevel;
                  
                  // 到达light级别时截屏（只截一次）
                  if (duration >= longPressConfig.lightThreshold && !longPressRef.current.hasScreenshot) {
                    takeFingerScreenshot(newPosition);
                  }
                  
                  // 只在UI需要更新时setState（减少频率）
                  const isActive = duration >= longPressConfig.autoTriggerDelay;
                  if (longPressState.isActive !== isActive || 
                      longPressState.currentLevel !== currentLevel ||
                      Math.abs(longPressState.currentDuration - duration) > 100) { // 100ms更新一次UI
                    setLongPressState(prev => ({
                      ...prev,
                      isActive,
                      currentDuration: duration,
                      currentLevel,
                      shouldTriggerOnMove: false
                    }));
                  }
                } else {
                  // 位置变化太大，标记需要触发OCR
                  const shouldTrigger = !longPressRef.current.hasTriggered && 
                                       (currentTime - longPressRef.current.startTime) >= longPressConfig.autoTriggerDelay;
                  
                  // 重置ref
                  longPressRef.current = {
                    startTime: currentTime,
                    startPosition: newPosition,
                    currentLevel: 'light',
                    hasTriggered: false,
                    hasScreenshot: false
                  };
                  
                  // 更新state
                  const triggerLevel = shouldTrigger ? longPressRef.current.currentLevel : false;
                  setLongPressState({
                    isActive: false,
                    currentDuration: 0,
                    currentLevel: 'light',
                    shouldTriggerOnMove: triggerLevel
                  });
                }
              } else {
                // 首次检测到手指位置
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
                  shouldTriggerOnMove: false
                });
              }
              
              console.log('[HandDetection] 检测到指尖位置 (含宽高比修正):', { 
                原始MediaPipe: { x: fingerTip.x.toFixed(3), y: fingerTip.y.toFixed(3) },
                视频尺寸: { w: video.videoWidth, h: video.videoHeight, aspect: videoAspect.toFixed(2) },
                容器尺寸: { w: containerRect.width, h: containerRect.height, aspect: containerAspect.toFixed(2) },
                实际显示区域: { w: videoDisplayWidth.toFixed(1), h: videoDisplayHeight.toFixed(1), offsetX: videoOffsetX.toFixed(1), offsetY: videoOffsetY.toFixed(1) },
                最终坐标: { x: x.toFixed(1), y: y.toFixed(1) },
                当前变换: { scale: videoScale.toFixed(2), translateX: videoTranslate.x.toFixed(1), translateY: videoTranslate.y.toFixed(1) }
              });
            }
          } else {
            setFingerTipPosition(null);
            // 手指消失时重置长按状态
            const shouldTrigger = !longPressRef.current.hasTriggered && 
                                 longPressRef.current.startPosition &&
                                 (Date.now() - longPressRef.current.startTime) >= longPressConfig.autoTriggerDelay;
            
            // 重置ref
            const triggerLevel = shouldTrigger ? longPressRef.current.currentLevel : false;
            longPressRef.current = {
              startTime: 0,
              startPosition: null,
              currentLevel: 'light',
              hasTriggered: false,
              hasScreenshot: false
            };
            
            // 更新state
            setLongPressState({
              isActive: false,
              currentDuration: 0,
              currentLevel: 'light',
              shouldTriggerOnMove: triggerLevel
            });
          }
        });
        
        if (!mounted) return;
        
        setHandsInstance(hands);
        console.log('[HandDetection] ✅ MediaPipe Hands 初始化完成');
        
        // 开始处理视频帧（优化帧率控制）
        let lastFrameTime = 0;
        const targetFPS = 30; // 目标帧率
        const frameInterval = 1000 / targetFPS;
        
        const processFrame = async (currentTime: number = 0) => {
          const video = videoRef.current;
          
          // 控制帧率，避免过度处理
          if (currentTime - lastFrameTime >= frameInterval) {
            if (video && video.readyState >= 2 && mounted && isHandDetectionEnabled) {
              try {
                await hands.send({ image: video });
                lastFrameTime = currentTime;
              } catch (error) {
                console.warn('[HandDetection] 处理帧失败:', error);
              }
            }
          }
          
          if (mounted && isHandDetectionEnabled) {
            requestAnimationFrame(processFrame);
          }
        };
        
        processFrame();
        
      } catch (error) {
        console.error('[HandDetection] MediaPipe Hands 初始化失败:', error);
        setDebugInfo(`手指检测初始化失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    
    initializeHandDetection();
    
    return () => {
      mounted = false;
      if (handsInstance) {
        try {
          handsInstance.close();
        } catch (error) {
          console.warn('[HandDetection] 清理实例时出错:', error);
        }
      }
    };
  }, [isHandDetectionEnabled]); // 只依赖启用状态

  // 4) MediaPipe Hands 配置更新（不重建实例）
  useEffect(() => {
    if (handsInstance && isHandDetectionEnabled) {
      console.log('[HandDetection] 更新配置:', handDetectionConfig);
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

  // 长按自动触发OCR（仅在达到hard等级时）
  useEffect(() => {
    if (longPressState.isActive && 
        longPressState.currentLevel === 'hard' &&
        longPressState.currentDuration >= longPressConfig.hardThreshold && 
        !longPressRef.current.hasTriggered && 
        fingerTipPosition && 
        !isProcessing) {
      
      console.log('[LongPress] 达到hard等级自动触发OCR，持续时间:', longPressState.currentDuration);
      
      // 标记为已触发
      longPressRef.current.hasTriggered = true;
      
      // 设置为hard级别
      setLevel('hard');
      
      // 触发OCR
      onFingerSelection();
    }
  }, [longPressState.isActive, longPressState.currentDuration, longPressState.currentLevel, fingerTipPosition, isProcessing]);

  // 监听手指移开/消失触发
  useEffect(() => {
    if (longPressState.shouldTriggerOnMove !== false && !isProcessing) {
      console.log('[LongPress] 手指移开/消失触发OCR，使用级别:', longPressState.shouldTriggerOnMove);
      
      // 标记为已触发
      longPressRef.current.hasTriggered = true;
      
      // 设置级别并触发OCR
      setLevel(longPressState.shouldTriggerOnMove);
      onFingerSelection();
      
      // 清除触发标志
      setLongPressState(prev => ({
        ...prev,
        shouldTriggerOnMove: false
      }));
    }
  }, [longPressState.shouldTriggerOnMove, isProcessing]);

    // 3) Apple Pencil pressure three levels (with轻微防抖)
  useEffect(() => {
    const el = overlayRef.current!;
    let last: Level = "light";
    let lastPressure = 0;
    let maxLevelInSession: Level = "light"; // 记录本次按压的最高level
    let isPressed = false; // 是否正在按压
    let t: any;
    
    // 降级机制相关变量
    let downgradeTimer: any;
    let pendingDowngradeLevel: Level | null = null;
    let stableStartTime = 0;
    
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        // 暂停视频
        const video = videoRef.current!;
        if (video && !video.paused) {
          video.pause();
          setIsVideoFrozen(true);
          console.log('[Drawing] 视频已暂停，开始绘制模式');
        }
        
        isPressed = true;
        setIsPressed(true); // 更新组件状态
        maxLevelInSession = "light"; // 重置最高level
        setCurrentMaxLevel("light"); // 同步状态
        
        // 开始新的绘制路径
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setDrawingPath([{x, y}]);
        setSelectionBounds(null);
        
        // 清除任何进行中的降级
        clearTimeout(downgradeTimer);
        pendingDowngradeLevel = null;
        stableStartTime = 0;
        console.log('[Pressure] 开始新的按压会话');
      }
    };
    
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === "pen" && isPressed) {
        isPressed = false;
        setIsPressed(false); // 更新组件状态
        
        // 清除降级计时器
        clearTimeout(downgradeTimer);
        pendingDowngradeLevel = null;
        
        // 使用本次按压的最高level
        setLevel(maxLevelInSession);
        setCurrentMaxLevel("light"); // 重置显示状态
        console.log('[Pressure] 按压结束，使用最高level:', maxLevelInSession);
        setDebugInfo(`按压完成 | 最终Level: ${maxLevelInSession}`);
        
        // 注意：不在这里计算selectionBounds，移到onPointerUp中处理
      }
    };
    
    const onMove = (e: PointerEvent) => {
      const p = e.pressure ?? 0;
      const isPen = e.pointerType === "pen";
      
      // 更新压力和设备类型状态
      setCurrentPressure(p);
      setIsUsingPen(isPen);
      
      if (!isPen) return;
      
      // 如果正在按压，记录绘制路径
      if (isPressed) {
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setDrawingPath(prev => {
          const newPath = [...prev, {x, y}];
          if (newPath.length % 5 === 0) { // 每5个点打印一次，避免日志过多
            console.log('[Drawing] 路径点数:', newPath.length, '最新点:', {x: x.toFixed(1), y: y.toFixed(1)});
          }
          return newPath;
        });
      }
      
      if (!isPressed) return; // 只在按压过程中处理压力level
      
      // Apple Pencil 1代和2代都有压力感应
      const currentLevel: Level = p < 0.33 ? "light" : p < 0.66 ? "medium" : "hard";
      
      // 升级逻辑：立即升级到更高level
      if (currentLevel === "hard" || (currentLevel === "medium" && maxLevelInSession === "light")) {
        maxLevelInSession = currentLevel;
        setCurrentMaxLevel(currentLevel); // 同步状态
        clearTimeout(downgradeTimer); // 清除降级计时器
        pendingDowngradeLevel = null;
        stableStartTime = 0;
      }
      
      // 降级逻辑：需要稳定0.5秒才能降级
      const levelOrder = { "light": 0, "medium": 1, "hard": 2 };
      if (levelOrder[currentLevel] < levelOrder[maxLevelInSession]) {
        // 当前压力对应的level低于最高level，开始降级计时
        
        if (pendingDowngradeLevel !== currentLevel) {
          // 开始新的降级计时
          pendingDowngradeLevel = currentLevel;
          stableStartTime = Date.now();
          clearTimeout(downgradeTimer);
          
          downgradeTimer = setTimeout(() => {
            // 0.5秒后确认降级
            if (pendingDowngradeLevel === currentLevel && isPressed) {
              maxLevelInSession = currentLevel;
              setCurrentMaxLevel(currentLevel); // 同步状态
              console.log('[Pressure] 稳定降级到:', currentLevel);
              setDebugInfo(`✏️ pressure: ${p.toFixed(3)} | downgrade to: ${currentLevel} | current highest: ${maxLevelInSession}`);
            }
          }, 500); // 0.5秒稳定时间
          
          console.log('[Pressure] 开始降级计时到:', currentLevel);
        }
        
        // 显示降级倒计时
        const elapsed = Date.now() - stableStartTime;
        const remaining = Math.max(0, 500 - elapsed);
        setDebugInfo(`✏️ pressure: ${p.toFixed(3)} | current: ${currentLevel} | highest: ${maxLevelInSession} | downgrade countdown: ${(remaining/1000).toFixed(1)}s`);
        
      } else {
        // 压力回升，取消降级
        if (pendingDowngradeLevel) {
          clearTimeout(downgradeTimer);
          pendingDowngradeLevel = null;
          stableStartTime = 0;
          console.log('[Pressure] 压力回升，取消降级');
        }
        
        // 正常显示
        setDebugInfo(`✏️ pressure: ${p.toFixed(3)} | current: ${currentLevel} | highest: ${maxLevelInSession}`);
      }
      
    };
    
    const onLeave = () => {
      setCurrentPressure(0);
      setIsUsingPen(false);
      setDebugInfo('');
      isPressed = false;
      setIsPressed(false); // 更新组件状态
      setCurrentMaxLevel("light"); // 重置显示状态
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

  // 4) 基于手指位置计算选择区域
  const calculateFingerSelectionArea = (fingerPos: {x: number, y: number}) => {
    // 在手指上方创建一个选择区域
    const areaWidth = 120;  // 选择区域宽度
    const areaHeight = 80;  // 选择区域高度
    const offsetY = -50;   // 向上偏移，避开手指遮挡
    
    return {
      left: Math.max(0, fingerPos.x - areaWidth / 2),
      top: Math.max(0, fingerPos.y + offsetY - areaHeight / 2),
      width: areaWidth,
      height: areaHeight
    };
  };

  // 5) 手指模式截屏函数（到达light级别时调用）
  const takeFingerScreenshot = async (fingerPos: {x: number, y: number}) => {
    if (longPressRef.current.hasScreenshot) {
      return; // 已经截过屏了
    }
    
    console.log('[Screenshot] 到达light级别，开始截屏，位置:', fingerPos);
    longPressRef.current.hasScreenshot = true;
    
    // finger模式保持视频播放，不暂停！否则无法继续检测手指
    console.log('[Screenshot] finger模式保持视频播放，继续检测手指位置');
    
    // 计算选择区域
    const selectionArea = calculateFingerSelectionArea(fingerPos);
    setSelectionBounds(selectionArea);
    
    // 这里只截屏，不做OCR，OCR留给后续的触发逻辑
    console.log('[Screenshot] 截屏完成，等待OCR触发');
  };

  // 6) 手指选择处理函数（OCR处理，使用已截好的屏）
  const onFingerSelection = async () => {
    if (!selectionBounds || !videoReady || !ocrReady || !worker) {
      console.log('[Finger] 条件不满足:', { 
        hasSelectionBounds: !!selectionBounds, 
        videoReady, 
        ocrReady, 
        hasWorker: !!worker 
      });
      return;
    }
    
    if (isProcessing) {
      console.log('[Finger] 已在处理中，跳过');
      return;
    }
    setIsProcessing(true);
    
    console.log('[Finger] 开始OCR处理，使用已截屏区域:', selectionBounds);
    
    setDebugInfo(`👆 手指模式: 选择区域 ${selectionBounds.width}×${selectionBounds.height}px`);
    
    // 使用与原来相同的OCR逻辑，但使用已截屏的selectionBounds
    try {
      // 创建canvas用于截图
      const canvas = document.createElement("canvas");
      canvas.width = selectionBounds.width;
      canvas.height = selectionBounds.height;
      const ctx = canvas.getContext("2d")!;
      
      // 从overlay截图的逻辑（复用原有逻辑）
      console.log('[Finger] 开始从overlay截取手指指向区域...');
      
      const overlay = overlayRef.current;
      const video = videoRef.current;
      if (!overlay || !video) {
        console.log('[Finger] overlay或video引用缺失');
        setIsProcessing(false);
        return;
      }
      
      // 获取尺寸信息
      const overlayRect = overlay.getBoundingClientRect();
      const videoRect = video.getBoundingClientRect();
      
      console.log('[Finger] 尺寸信息:', {
        手指选择区域: selectionBounds,
        overlay尺寸: { width: overlayRect.width, height: overlayRect.height },
        video显示尺寸: { width: videoRect.width, height: videoRect.height },
        当前变换: { scale: videoScale, translate: videoTranslate }
      });
      
      // 创建临时canvas来绘制整个overlay内容
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = overlayRect.width;
      tempCanvas.height = overlayRect.height;
      const tempCtx = tempCanvas.getContext("2d")!;
      
      // 绘制video到临时canvas（包含所有变换）
      tempCtx.save();
      
      // 应用与video相同的变换
      tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
      tempCtx.scale(-1, 1); // 水平翻转
      tempCtx.scale(videoScale, videoScale); // 缩放
      tempCtx.translate(videoTranslate.x, videoTranslate.y); // 平移
      tempCtx.translate(-tempCanvas.width / 2, -tempCanvas.height / 2);
      
      // 绘制video，保持原始宽高比
      const videoAspect = video.videoWidth / video.videoHeight;
      const canvasAspect = tempCanvas.width / tempCanvas.height;
      
      let drawWidth, drawHeight, drawX, drawY;
      
      if (videoAspect > canvasAspect) {
        drawWidth = tempCanvas.width;
        drawHeight = tempCanvas.width / videoAspect;
        drawX = 0;
        drawY = (tempCanvas.height - drawHeight) / 2;
      } else {
        drawHeight = tempCanvas.height;
        drawWidth = tempCanvas.height * videoAspect;
        drawX = (tempCanvas.width - drawWidth) / 2;
        drawY = 0;
      }
      
      tempCtx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
      tempCtx.restore();
      
      // 从临时canvas中提取选择区域
      const safeLeft = Math.max(0, Math.min(selectionBounds.left, tempCanvas.width - 1));
      const safeTop = Math.max(0, Math.min(selectionBounds.top, tempCanvas.height - 1));
      const safeWidth = Math.min(selectionBounds.width, tempCanvas.width - safeLeft);
      const safeHeight = Math.min(selectionBounds.height, tempCanvas.height - safeTop);
      
      const selectionImageData = tempCtx.getImageData(safeLeft, safeTop, safeWidth, safeHeight);
      ctx.putImageData(selectionImageData, 0, 0);
      
      console.log('[Finger] 手指模式截图完成');
      
      // 图像增强处理
      if (isEnhancementEnabled) {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
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
        
        ctx.putImageData(imageData, 0, 0);
        console.log('[Finger] ✅ 图像增强完成');
      }
      
      // 获取处理后的图像
      const dataURL = canvas.toDataURL();
      setCapturedImage(dataURL);
      
      // OCR识别
      console.log('[Finger] 开始OCR识别...');
      const { data: { text } } = await worker.recognize(canvas);
      const picked = text.trim().slice(0, 400);
      
      console.log('[Finger] OCR识别结果:', { 
        originalLength: text.length, 
        trimmedLength: picked.length, 
        text: picked 
      });
      
      setAnswer(`👆 手指模式调用LLM... (level: ${level})\n\n识别文字: ${picked || "(未检测到文字)"}`);
      
      if(picked.length === 0) {
        setAnswer("👆 手指模式: 未检测到文字");
        console.log('[Finger] 文本为空');
        return;
      }
      
      // 调用LLM
      const resp = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: picked || "No text", level, image: dataURL, streaming: isStreaming }),
      });
      
      if (!resp.ok) {
        throw new Error(`LLM API 错误: ${resp.status}`);
      }
      
      if (isStreaming) {
        // 流式响应处理
        const reader = resp.body?.getReader();
        if (!reader) throw new Error('无法获取流式响应');
        
        setAnswer("");
        
        // 设置浮窗位置（在选择区域旁边）
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
                  console.log('[Finger Streaming] 跳过无效行:', line);
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        // 非流式响应
        const data = await resp.json();
        const content = data.content || "No response";
        
        console.log('[Finger] LLM响应完成:', { contentLength: content.length });
        setAnswer(`👆 手指模式结果:\n\n${content}`);
        
        // 设置浮窗
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
      console.error('[Finger] 处理失败:', err);
      setAnswer(`👆 手指模式错误: ${err?.message || String(err)}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // 6) 点按（PointerUp 更稳）→ 裁 ROI → OCR → 调 LLM
  const onPointerUp = async (e: React.PointerEvent<HTMLElement>) => {
    console.log('[Click] 检测到点击事件:', {
      pointerType: e.pointerType,
      pressure: e.pressure,
      clientX: e.clientX,
      clientY: e.clientY,
      videoReady,
      ocrReady,
      hasWorker: !!worker,
      drawingPathLength: drawingPath.length
    });
    
    // 防止重复处理
    if (isProcessing) {
      console.log('[OCR] 已在处理中，跳过');
      return;
    }
    setIsProcessing(true);

    // 首先计算绘制区域的边界
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
    
    // 暂停视频，冻结画面
    const video = videoRef.current!;
    if (video && !video.paused) {
      video.pause();
      setIsVideoFrozen(true);
      console.log('[Click] 视频已暂停，画面冻结');
    }
    
    // 更新当前压力显示
    setCurrentPressure(e.pressure || 0);
    setIsUsingPen(e.pointerType === "pen");
    
    if (!videoReady) { 
      setAnswer("Video is not ready, please wait..."); 
      console.log('[Click] 视频未就绪');
      return; 
    }
    if (!ocrReady || !worker) { 
      setAnswer("OCR engine is still loading, please wait..."); 
      console.log('[Click] OCR 未就绪');
      return; 
    }

    if (!videoReady || !ocrReady || !worker) {
      console.log('[OCR] 未准备就绪:', { videoReady, ocrReady, hasWorker: !!worker });
      return;
    } 

    const v = videoRef.current;
    const overlay = overlayRef.current;
    if (!v || !overlay) {
      console.log('[OCR] 元素引用缺失');
      return;
    }
    
    // 直接从overlay截图，避免复杂的坐标转换
    console.log('[OCR] 使用overlay直接截图方法');
    
    if (!calculatedBounds || calculatedBounds.width <= 5 || calculatedBounds.height <= 5) {
      setAnswer("请先用Apple Pencil画出要识别的区域");
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
      console.log('[Enhancement] 开始图像增强处理...');
      
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
      console.log('[Enhancement] ✅ 图像增强完成（对比度+二值化）');
    };
    
    console.log('[Click] 开始从overlay直接截图...', {
      canvasSize: { width: canvas.width, height: canvas.height },
      selectionBounds: calculatedBounds
    });

    try {
      // 方法：使用getDisplayMedia API或直接从DOM截图
      // 但最简单的方法是创建一个临时的canvas来绘制整个overlay，然后裁剪
      
      console.log('[Screenshot] 开始截取overlay区域...');
      
      // 获取各种尺寸信息用于调试
      const overlayRect = overlay.getBoundingClientRect();
      const videoRect = v.getBoundingClientRect();
      const videoNaturalSize = { width: v.videoWidth, height: v.videoHeight };
      const containerSize = { width: 500, height: 500 }; // 你设置的容器尺寸
      
      console.log('[Debug] 尺寸对比:', {
        蓝框区域: calculatedBounds,
        overlay尺寸: { width: overlayRect.width, height: overlayRect.height },
        video显示尺寸: { width: videoRect.width, height: videoRect.height },
        video原始尺寸: videoNaturalSize,
        容器尺寸: containerSize,
        当前变换: { scale: videoScale, translate: videoTranslate }
      });
      
      // 创建一个临时canvas来绘制整个overlay内容
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = overlayRect.width;
      tempCanvas.height = overlayRect.height;
      const tempCtx = tempCanvas.getContext("2d")!;
      
      console.log('[Debug] 临时Canvas尺寸:', { width: tempCanvas.width, height: tempCanvas.height });
      
      // 绘制video到临时canvas（包含所有变换）
      tempCtx.save();
      
      console.log('[Debug] 开始应用变换...');
      
      // 应用与video相同的变换
      tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
      console.log('[Debug] 1. 移动到中心:', tempCanvas.width / 2, tempCanvas.height / 2);
      
      tempCtx.scale(-1, 1); // 水平翻转
      console.log('[Debug] 2. 水平翻转');
      
      tempCtx.scale(videoScale, videoScale); // 缩放
      console.log('[Debug] 3. 缩放:', videoScale);
      
      tempCtx.translate(videoTranslate.x, videoTranslate.y); // 平移
      console.log('[Debug] 4. 平移:', videoTranslate.x, videoTranslate.y);
      
      tempCtx.translate(-tempCanvas.width / 2, -tempCanvas.height / 2);
      console.log('[Debug] 5. 移回原点');
      console.log('[Debug] 注意：截图不包含透视变换（Canvas 2D限制），透视强度:', perspectiveStrength);
      console.log('[Debug] 坐标系统已修复：透视和其他变换分离处理');
      
      // 绘制video，保持原始宽高比
      // 问题可能在这里：我们应该绘制video的原始尺寸，而不是强制拉伸到canvas尺寸
      const videoAspect = v.videoWidth / v.videoHeight;
      const canvasAspect = tempCanvas.width / tempCanvas.height;
      
      let drawWidth, drawHeight, drawX, drawY;
      
      if (videoAspect > canvasAspect) {
        // video更宽，以宽度为准
        drawWidth = tempCanvas.width;
        drawHeight = tempCanvas.width / videoAspect;
        drawX = 0;
        drawY = (tempCanvas.height - drawHeight) / 2;
      } else {
        // video更高，以高度为准
        drawHeight = tempCanvas.height;
        drawWidth = tempCanvas.height * videoAspect;
        drawX = (tempCanvas.width - drawWidth) / 2;
        drawY = 0;
      }
      
      console.log('[Debug] 绘制参数:', {
        videoAspect,
        canvasAspect,
        drawArea: { x: drawX, y: drawY, width: drawWidth, height: drawHeight }
      });
      
      tempCtx.drawImage(v, drawX, drawY, drawWidth, drawHeight);
      tempCtx.restore();
      
      // 从临时canvas中提取选择区域
      console.log('[Debug] 准备提取区域:', {
        提取坐标: calculatedBounds,
        临时Canvas尺寸: { width: tempCanvas.width, height: tempCanvas.height },
        最终Canvas尺寸: { width: canvas.width, height: canvas.height }
      });
      
      // 检查提取区域是否超出边界
      const safeLeft = Math.max(0, Math.min(calculatedBounds.left, tempCanvas.width - 1));
      const safeTop = Math.max(0, Math.min(calculatedBounds.top, tempCanvas.height - 1));
      const safeWidth = Math.min(calculatedBounds.width, tempCanvas.width - safeLeft);
      const safeHeight = Math.min(calculatedBounds.height, tempCanvas.height - safeTop);
      
      console.log('[Debug] 安全边界检查:', {
        原始: calculatedBounds,
        安全: { left: safeLeft, top: safeTop, width: safeWidth, height: safeHeight }
      });
      
      const selectionImageData = tempCtx.getImageData(
        safeLeft, 
        safeTop, 
        safeWidth, 
        safeHeight
      );
      
      console.log('[Debug] 提取的ImageData:', {
        width: selectionImageData.width,
        height: selectionImageData.height,
        dataLength: selectionImageData.data.length
      });
      
      // 将提取的区域绘制到最终canvas
      ctx.putImageData(selectionImageData, 0, 0);
      
      console.log('[Screenshot] 从overlay截图完成');
      
      // 额外调试：保存临时canvas用于检查
      const tempDataURL = tempCanvas.toDataURL();
      console.log('[Debug] 临时Canvas内容长度:', tempDataURL.length);
      console.log('[Debug] 你可以在浏览器控制台复制这个URL查看临时canvas内容:');
      console.log(tempDataURL.substring(0, 100) + '...');
      
      // 检查canvas是否真的有内容
      const imageData = ctx.getImageData(0, 0, Math.min(10, canvas.width), Math.min(10, canvas.height));
      const hasContent = imageData.data.some(pixel => pixel !== 0);
      console.log('[Click] Canvas内容检查:', { 
        hasContent,
        samplePixels: Array.from(imageData.data.slice(0, 12))
      });
      
      if (!hasContent) {
        console.error('[Click] Canvas内容为空！尝试iPad备用捕获方法...');
        
        // iPad备用方法：尝试不同的绘制参数
        try {
          // 方法1：确保视频完全加载
          if (v.readyState < 2) {
            setAnswer("Error: Video not fully loaded, please wait for video to be ready");
            setCapturedImage("");
            return;
          }
          
          // 方法2：尝试绘制整个视频然后裁剪
          const tempCanvas = document.createElement("canvas");
          tempCanvas.width = v.videoWidth;
          tempCanvas.height = v.videoHeight;
          const tempCtx = tempCanvas.getContext("2d")!;
          
          // 绘制整个视频帧
          tempCtx.drawImage(v, 0, 0);
          
          // 检查整个视频帧是否有内容
          const fullImageData = tempCtx.getImageData(0, 0, Math.min(10, v.videoWidth), Math.min(10, v.videoHeight));
          const fullHasContent = fullImageData.data.some(pixel => pixel !== 0);
          
          if (!fullHasContent) {
            setAnswer("Error: No pixel data from video on iPad, possibly Safari security restrictions");
            setCapturedImage("");
            return;
          }
          
          // 从完整视频帧中提取ROI
          const roiImageData = tempCtx.getImageData(
            calculatedBounds.left, calculatedBounds.top, 
            calculatedBounds.width, calculatedBounds.height
          );
          ctx.putImageData(roiImageData, 0, 0);
          
          console.log('[Click] iPad备用捕获成功');
          
        } catch (fallbackError: any) {
          console.error('[Click] iPad备用捕获也失败:', fallbackError);
          setAnswer(`Error: All video capture methods failed - ${fallbackError.message || String(fallbackError)}`);
          setCapturedImage("");
          return;
        }
      }
      
    } catch (drawError: any) {
      console.error('[Click] 绘制视频帧到canvas时出错:', drawError);
      setAnswer(`Error: Failed to draw video frame to canvas - ${drawError.message || String(drawError)}`);
      setCapturedImage("");
      return;
    }

    console.log('[Click] Canvas 创建完成，开始 OCR...', {
      canvasSize: { width: canvas.width, height: canvas.height },
      selectionBounds: calculatedBounds,
      videoSize: { width: v.videoWidth, height: v.videoHeight }
    });

    // 调试：将canvas内容转为base64查看是否正常
    let dataURL;
    try {
      dataURL = canvas.toDataURL();
      console.log('[Click] Canvas转换为DataURL成功，长度:', dataURL.length);
      console.log('[Click] DataURL前缀:', dataURL.substring(0, 50));
    } catch (toDataURLError: any) {
      console.error('[Click] Canvas转换为DataURL失败:', toDataURLError);
      setAnswer(`Error: Canvas to DataURL failed - ${toDataURLError.message || String(toDataURLError)}`);
      setCapturedImage("");
      return;
    }
    
    // 根据设置决定是否进行图像增强
    if (isEnhancementEnabled) {
      enhanceImage(canvas, ctx);
      console.log('[Enhancement] ✅ 图像增强已应用');
    } else {
      console.log('[Enhancement] ⚪ 图像增强已禁用');
    }
    
    // 获取处理后的图像用于显示
    const finalDataURL = canvas.toDataURL();
    setCapturedImage(finalDataURL);
    
    console.log('[Enhancement] 图像增强完成，开始OCR识别...');

    try {
      const { data: { text } } = await worker.recognize(canvas);
      const picked = text.trim().slice(0, 400);
      console.log('[OCR] 识别结果:', { 
        originalLength: text.length, 
        trimmedLength: picked.length, 
        text: picked 
      });
      
      setAnswer(`calling LLM... (pressure level: ${level})\n\nrecognized text: ${picked || "(no text detected)"}`);
      setDebugInfo(`pressure level: ${level})\n\nrecognized text: ${picked || "(no text detected)"}`);
      if(picked.length === 0) {
        setAnswer("no text detected");
        console.log('[OCR] 文本为空，可能原因：图像质量、光线、角度、或该区域确实没有文字');
        return;
      }

      // 调 LLM
      const resp = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: picked || "No text", level, image: dataURL, streaming: isStreaming }),
      });

      console.log('[LLM] API 调用状态:', resp.status);

      if (!resp.ok) {
        throw new Error(`LLM API 错误: ${resp.status}`);
      }

      if (isStreaming) {
        // Handle streaming response
        const reader = resp.body?.getReader();
        if (!reader) {
          throw new Error('无法获取流式响应');
        }

        setAnswer(""); // Clear previous answer
        
        // 初始化浮窗位置
        if (calculatedBounds) {
          const containerWidth = 500;
          const floatingWidth = 240;
          
          let floatingX, floatingY;
          
          // 获取video容器在页面中的位置
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
                    
                    // 更新浮窗内容
                    if (calculatedBounds) {
                      setFloatingResponse(prev => prev ? {
                        ...prev,
                        text: streamingText
                      } : null);
                    }
                  }
                } catch (e) {
                  console.log('[Streaming] 跳过无效行:', line);
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
        
        console.log('[LLM] 响应完成:', { contentLength: content.length });
        setAnswer(content);
        
        // 设置浮窗位置（在选择框旁边）
        if (calculatedBounds) {
          const containerWidth = 500; // 视频容器宽度
          const floatingWidth = 240; // 浮窗大约宽度
          
          // 智能位置：显示在选择框上面
          let floatingX, floatingY;
          
          // 获取video容器在页面中的位置
          const videoContainer = document.querySelector('.video-container');
          const containerRect = videoContainer?.getBoundingClientRect();
          
          if (containerRect) {
            // X坐标：相对于页面的绝对位置
            floatingX = containerRect.left + calculatedBounds.left + calculatedBounds.width / 2;
            
            // Y坐标：相对于页面的绝对位置，显示在选择框上面
            floatingY = containerRect.top + calculatedBounds.top - 10;
          } else {
            // 备用方案
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
    <main className="min-h-screen bg-gray-50 p-4">
   
      <h1 className="text-xl font-semibold mb-3">PressureLens — Web</h1>

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
        {deviceInfo && <div className="mt-1 text-xs text-purple-600">📱 {deviceInfo}</div>}
      </div>

      {/* 压力条显示 */}
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
                transition: 'none' // 移除过渡动画，实现实时响应
              }}
            />
            <div className="absolute inset-0 flex items-center justify-center text-xs font-medium text-white mix-blend-difference">
              {isPressed ? (currentPressure * 100).toFixed(0) : 0}%
            </div>
            {/* 压力等级分界线 */}
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

      {/* 模式切换 */}
      <div className="mb-3 flex gap-2 items-center">
        <span className="text-sm text-gray-600">input mode:</span>
        <button
          onClick={() => {
            setHandDetectionMode('pencil');
            setIsHandDetectionEnabled(false);
            setFingerTipPosition(null);
            // setDebugInfo('切换到 Apple Pencil 模式');
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
            // setDebugInfo('切换到手指检测模式，请将手指指向纸面文字');
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

      {/* 手指检测状态显示 */}
      {handDetectionMode === 'finger' && (
        <div className="mb-3 p-3 bg-green-50 rounded-lg border border-green-200">
          <div className="text-sm text-green-700 mb-2">
            📷 长按模式: {fingerTipPosition ? '✅ 检测到手指' : '⏳ 寻找手指中...'}
            {fingerTipPosition && (
              <span className="ml-2">
               位置: ({fingerTipPosition.x.toFixed(0)}, {fingerTipPosition.y.toFixed(0)})
              </span>
            )}
          </div>
          <div className="text-xs text-gray-600 mb-2">
            💡 将手指指向纸面文字并保持不动，系统会根据停留时间自动选择详细程度：
            <br/>• 0.8-2.0秒: Light级别 (简单回答)
            <br/>• 2.0-3.5秒: Medium级别 (正常详细度) 
            <br/>• 3.5秒以上: Hard级别 (详细分析+建议)
          </div>
          
          {/* 长按状态显示 */}
          {longPressState.isActive && (
            <div className="mt-2 p-2 bg-white rounded border">
              <div className="text-xs text-gray-700">
                🔄 长按进行中: <span className="font-bold text-blue-600">{longPressState.currentLevel}</span> 级别
                <span className="ml-2">({(longPressState.currentDuration / 1000).toFixed(1)}秒)</span>
                {longPressRef.current.hasTriggered && <span className="ml-2 text-green-600">✅ 已触发</span>}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {longPressState.currentLevel === 'hard' && !longPressRef.current.hasTriggered ? 
                  '⚡ 即将自动触发OCR...' :
                  longPressState.currentDuration >= longPressConfig.autoTriggerDelay ?
                  '👆 移开手指确认当前级别' : '⏳ 继续按住提升级别'
                }
              </div>
            </div>
          )}
          
          {!fingerTipPosition && (
            <div className="mt-2 text-xs text-amber-600">
              {/* 💡 提示: 确保光线充足，将手指清晰地伸入摄像头视野内 */}
            </div>
          )}
          
          {/* 手指检测精度配置 */}
          <div className="mt-3 p-2 bg-gray-50 rounded border">
            {/* <div className="text-xs font-medium text-gray-700 mb-2"></div> */}
            
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
                    
                    // 如果实例存在，立即更新配置
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
            
            {/* <div className="mt-2 text-xs text-gray-500">
              • 检测阈值高 = 更准确但可能漏检 | 低 = 更敏感但可能误检<br/>
              • 跟踪阈值高 = 更稳定但反应慢 | 低 = 更灵敏但可能抖动<br/>
              • 精确模式 = 更准确但更耗性能 | 快速模式 = 性能好但精度略低
            </div> */}
          </div>
        </div>
      )}

      {/* Apple Pencil 1代手动level切换 */}
      <div className="mb-3 flex gap-2">
        <span className="text-sm text-gray-600">pressure level:</span>
        {(['light', 'medium', 'hard'] as Level[]).map((l) => {
          // 如果正在按压，显示currentMaxLevel；否则显示设定的level
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

      {/* 流式显示切换 */}
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
          {isStreaming ? '🔄 streaming' : '📄 instant'}
        </button>
      </div>

      {/* 图像增强切换 */}
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
          {isEnhancementEnabled ? '✨ enhanced' : '📸 original'}
        </button>
        <span className="text-xs text-gray-500">
          {isEnhancementEnabled ? '(contrast + grayscale + binarization)' : '(raw camera image)'}
        </span>
      </div>

      {/* 透视强度控制 */}
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
              setDebugInfo(`🔄 透视强度: ${value}% (${(value * 0.3).toFixed(1)}度)`);
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
           touchAction: 'pan-x pan-y pinch-zoom' // 允许平移和缩放
         }}
        >
                  {/* 透视变换容器 */}
        <div 
          style={{
            width: '100%',
            height: '100%',
            transform: `perspective(800px) rotateX(${perspectiveStrength * 0.3}deg)`,
            transformOrigin: 'center top', // 透视变换以顶部为原点
            transition: 'transform 0.1s ease-out'
          }}
        >
          <video 
            ref={videoRef} 
            className="video-element" 
            playsInline 
            style={{
              pointerEvents: 'none', // 禁用video上的事件，只在overlay上处理
              transform: `scaleX(-1) scale(${videoScale}) translate(${videoTranslate.x}px, ${videoTranslate.y}px)`, // 左右翻转+缩放+平移
              transformOrigin: 'center center', // 其他变换以中心为原点，保持原有逻辑
              width: '500px',
              height: '500px',
              transition: 'transform 0.1s ease-out'
            }}
          />
        </div>
        {/* 盖在视频上用于接收手势事件 */}
        <div
          ref={overlayRef}
          onPointerUp={(e) => {
            // 只有Apple Pencil才触发OCR
            if (e.pointerType === "pen") {
              console.log('[Events] Apple Pencil PointerUp - 触发OCR');
              onPointerUp(e);
            } else {
              console.log('[Events] 非Apple Pencil事件，跳过OCR:', e.pointerType);
            }
          }}
          onPointerDown={(e) => {
            // 如果正在拖拽浮窗，不处理其他手势
            if (isDraggingFloat) return;
            
            console.log('[Events] PointerDown:', {
              type: e.pointerType,
              pressure: e.pressure,
              x: e.clientX,
              y: e.clientY,
              isPrimary: e.isPrimary
            });
            
            if (e.pointerType === "pen") {
              // Apple Pencil - 只用于绘制，不处理拖拽
              console.log('[Pencil] Apple Pencil按下，准备绘制');
              setDebugInfo(`✏️ Apple Pencil: 压力:${e.pressure?.toFixed(2) || 'N/A'}`);
            } else if (e.pointerType === "touch") {
              // 手指 - 用于缩放拖拽
              console.log('[Finger] 手指按下，准备手势操作');
              (e.currentTarget as any).lastPointerX = e.clientX;
              (e.currentTarget as any).lastPointerY = e.clientY;
              (e.currentTarget as any).initialTranslate = {...videoTranslate};
              (e.currentTarget as any).fingerPointerId = e.pointerId;
              setDebugInfo(`👆 手指按下: (${e.clientX.toFixed(0)}, ${e.clientY.toFixed(0)})`);
            }
          }}
          onTouchStart={(e) => {
            if (e.touches.length === 2) {
              // 双指缩放开始（只有手指能产生双指触摸）
              const touch1 = e.touches[0];
              const touch2 = e.touches[1];
              const distance = Math.sqrt(
                Math.pow(touch2.clientX - touch1.clientX, 2) + 
                Math.pow(touch2.clientY - touch1.clientY, 2)
              );
              (e.currentTarget as any).initialDistance = distance;
              (e.currentTarget as any).initialScale = videoScale;
              console.log('[Zoom] 双指缩放开始:', { distance, currentScale: videoScale });
              setDebugInfo(`🔍 双指缩放开始 (${distance.toFixed(0)}px)`);
            }
          }}
          onPointerMove={(e) => {
            // 如果正在拖拽浮窗，不处理其他手势
            if (isDraggingFloat) return;
            
            if (e.pointerType === "pen") {
              // Apple Pencil - 只处理绘制，不处理拖拽
              return;
            } else if (e.pointerType === "touch") {
              // 手指拖拽处理（仅在放大时允许）
              const fingerPointerId = (e.currentTarget as any).fingerPointerId;
              const lastX = (e.currentTarget as any).lastPointerX;
              const lastY = (e.currentTarget as any).lastPointerY;
              const initialTranslate = (e.currentTarget as any).initialTranslate;
              
              if (e.pointerId === fingerPointerId && lastX !== undefined && lastY !== undefined && initialTranslate && videoScale > 1) {
                const deltaX = e.clientX - lastX;
                const deltaY = e.clientY - lastY;
                
                // 由于视频有水平翻转，X方向需要反向
                setVideoTranslate({
                  x: initialTranslate.x - deltaX / videoScale, // 注意这里是减号
                  y: initialTranslate.y + deltaY / videoScale
                });
                setDebugInfo(`📱 手指拖拽: (${deltaX.toFixed(0)}, ${deltaY.toFixed(0)}) 缩放:${(videoScale * 100).toFixed(0)}%`);
              }
            }
          }}
          onTouchMove={(e) => {
            e.preventDefault(); // 防止页面滚动
            
            if (e.touches.length === 2) {
              // 双指缩放（只有手指才能触发，Apple Pencil不会产生多点触摸）
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
                setDebugInfo(`🔍 双指缩放: ${(newScale * 100).toFixed(0)}%`);
                console.log('[Zoom] 双指缩放:', newScale);
              }
            }
            // 移除单指拖拽处理，改用PointerMove
          }}
          onTouchEnd={(e) => {
            if (e.touches.length === 0) {
              // 所有手指离开
              setDebugInfo(`✅ 手势结束 - 缩放: ${(videoScale * 100).toFixed(0)}%`);
            }
          }}
          className="absolute inset-0 z-10 cursor-crosshair select-none"
          style={{ 
            touchAction: 'none', // 禁用默认触摸行为，完全自定义
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
            WebkitTapHighlightColor: 'transparent',
            pointerEvents: 'auto' // 确保指针事件可以触发
          }}
          title="Use Apple Pencil to select the region"
        >
          {/* 手指检测模式的视觉反馈 */}
          {handDetectionMode === 'finger' && fingerTipPosition && (
            <>
              {/* 手指指尖标记 */}
              <div
                className="absolute w-3 h-3 bg-red-500 rounded-full pointer-events-none border-2 border-white shadow-lg z-20"
                style={{
                  left: `${fingerTipPosition.x - 8}px`,
                  top: `${fingerTipPosition.y - 8}px`,
                  animation: longPressState.isActive ? 'none' : 'pulse 2s infinite'
                }}
              />
              
              {/* 长按进度圆环 */}
              {longPressRef.current.startPosition && longPressState.currentDuration > 0 && (
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
                    {/* 背景圆环 */}
                    <circle
                      cx="25"
                      cy="25"
                      r="20"
                      stroke="rgba(255,255,255,0.3)"
                      strokeWidth="3"
                      fill="none"
                    />
                    {/* 进度圆环 */}
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
                  
                  {/* 中心级别指示器 */}
                  <div
                    className="absolute inset-0 flex items-center justify-center text-white text-xs font-bold"
                    style={{
                      textShadow: '0 0 4px rgba(0,0,0,0.8)'
                    }}
                  >
                    {longPressState.currentLevel === 'hard' ? 'H' :
                     longPressState.currentLevel === 'medium' ? 'M' : 'L'}
                  </div>
                  
                  {/* 时间显示和提示 */}
                  <div
                    className="absolute -bottom-8 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-70 text-white text-xs px-2 py-1 rounded whitespace-nowrap text-center"
                  >
                    <div>{(longPressState.currentDuration / 1000).toFixed(1)}s</div>
                    {longPressState.currentLevel === 'hard' && !longPressRef.current.hasTriggered && (
                      <div className="text-yellow-300 animate-pulse">即将自动触发</div>
                    )}
                    {longPressState.currentLevel !== 'hard' && longPressState.currentDuration >= longPressConfig.autoTriggerDelay && (
                      <div className="text-green-300">移开手指确认</div>
                    )}
                  </div>
                </div>
              )}
              
              {/* 预览选择区域 */}
              {(() => {
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
                    {/* 区域标签 */}
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

          {/* Apple Pencil 绘制路径可视化 */}
          {handDetectionMode === 'pencil' && drawingPath.length > 1 && (() => {
            // 计算运动距离
            let distance = 0;
            for (let i = 1; i < drawingPath.length; i++) {
              const dx = drawingPath[i].x - drawingPath[i-1].x;
              const dy = drawingPath[i].y - drawingPath[i-1].y;
              distance += Math.sqrt(dx * dx + dy * dy);
            }
            
            // 只有运动距离大于15px才显示路径线
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
          
          {/* Apple Pencil 当前绘制点显示 */}
          {handDetectionMode === 'pencil' && isPressed && drawingPath.length > 0 && (
            <div
              className="absolute w-2 h-2 bg-blue-500 rounded-full pointer-events-none"
              style={{
                left: `${drawingPath[drawingPath.length - 1].x - 4}px`,
                top: `${drawingPath[drawingPath.length - 1].y - 4}px`
              }}
            />
          )}
          
          {/* 选择区域边界可视化 */}
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
        
        {/* 浮窗响应 - 移到video容器外层，避免被边框遮挡 */}
        {floatingResponse && (
          <div
            className="fixed z-50 select-none"
            style={{
              left: `${floatingResponse.position.x}px`,
              top: `${floatingResponse.position.y}px`,
              transform: 'translate(-50%, -100%)', // 水平居中，垂直向上偏移
              pointerEvents: 'auto', // 允许交互
              width: '240px', // 固定宽度，防止拖拽时变化
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
                console.log('[Float] 开始拖拽浮窗');
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
                console.log('[Float] 结束拖拽浮窗');
              }
            }}
            onPointerLeave={() => {
              if (isDraggingFloat) {
                setIsDraggingFloat(false);
                console.log('[Float] 拖拽浮窗离开区域');
              }
            }}
          >
            <div className="bg-black bg-opacity-90 text-white text-xs rounded-lg shadow-xl backdrop-blur-sm border border-gray-600">
              {/* 标题栏和关闭按钮 */}
              <div className="drag-handle flex justify-between items-center p-2 pb-1 cursor-move border-b border-gray-600">
                <div className="text-gray-300 text-xs">AI Response</div>
                <button
                  onClick={() => {
                    setFloatingResponse(null);
                    console.log('[Float] 关闭浮窗');
                  }}
                  className="text-gray-400 hover:text-white transition-colors w-4 h-4 flex items-center justify-center rounded hover:bg-gray-700"
                  title="关闭"
                >
                  ×
                </button>
              </div>
              
              {/* 内容区域 */}
              <div className="p-2 pt-1">
                <div className="whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {floatingResponse.text || "正在分析..."}
                </div>
              </div>
              
              {/* 小箭头指向下方的选择框 */}
              <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-black bg-opacity-90 rotate-45 border-r border-b border-gray-600"></div>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 p-3 rounded-lg border bg-white max-w-md whitespace-pre-wrap text-sm">
        <div className="font-medium mb-1">Response</div>
        {answer || "Tap the video to OCR the region under your pen, then call LLM."}
      </div>

      {/* 显示捕获的图像 */}
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

      {/* 测试按钮 */}
      <div className="mt-4 flex gap-2">
        <button
          onClick={async () => {
            console.log('[Test] 测试 OCR 功能');
            setDebugInfo('测试模式：模拟点击');
            if (!ocrReady || !worker) {
              setAnswer("OCR 还未就绪");
              return;
            }
            
            // 创建一个测试图片（纯白背景黑字）
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
              setAnswer("测试 OCR 中...");
              const { data: { text } } = await worker.recognize(canvas);
              setAnswer(`测试成功！识别结果: "${text.trim()}"`);
              console.log('[Test] OCR 测试成功:', text);
            } catch (err: any) {
              setAnswer(`测试失败: ${err.message}`);
              console.error('[Test] OCR 测试失败:', err);
            }
          }}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm"
        >
          🧪 test OCR
        </button>
        
        <button
          onClick={() => {
            setDebugInfo('');
            setAnswer('');
            setFloatingResponse(null); // 清除浮窗
            console.log('[Test] 清除调试信息');
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
            setDebugInfo('🔄 视频变换已全部重置');
            console.log('[Reset] 重置缩放、位置和透视');
          }}
          className="px-4 py-2 bg-indigo-500 text-white rounded hover:bg-indigo-600 text-sm"
        >
          🔄 重置变换
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
                console.log('[Video] 恢复视频播放');
              }
            }}
            className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 text-sm"
          >
            ▶️ reset
          </button>
        )}
      </div>

      {/* iPad 事件测试区域 */}
      {/* <div className="mt-4 p-4 border border-dashed border-gray-300 rounded-lg bg-yellow-50">
        <div className="text-sm font-medium mb-2"> iPad 事件测试区域</div>
        <div
          onPointerDown={(e) => {
            console.log('[TestArea] PointerDown:', e.pointerType, e.pressure);
            setDebugInfo(`测试区 PointerDown: ${e.pointerType}`);
          }}
          onPointerUp={(e) => {
            console.log('[TestArea] PointerUp:', e.pointerType, e.pressure);
            setDebugInfo(`测试区 PointerUp: ${e.pointerType} - 事件正常！`);
          }}
          onTouchStart={(e) => {
            console.log('[TestArea] TouchStart:', e.touches.length);
            setDebugInfo(`测试区 TouchStart: ${e.touches.length} 触点`);
          }}
          onTouchEnd={(e) => {
            console.log('[TestArea] TouchEnd:', e.changedTouches.length);
            setDebugInfo(`测试区 TouchEnd: ${e.changedTouches.length} 触点 - 事件正常！`);
          }}
          className="w-full h-20 bg-white border rounded cursor-pointer flex items-center justify-center text-gray-600"
          style={{
            touchAction: 'manipulation',
            userSelect: 'none',
            WebkitUserSelect: 'none'
          }}
        >
          点击这里测试事件是否正常 (手指/Apple Pencil)
        </div>
        <div className="text-xs text-gray-500 mt-1">
          如果这个区域能检测到点击，说明事件系统正常，问题可能在视频覆盖层
        </div>
      </div> */}


    </main>
  );
}
