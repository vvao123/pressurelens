"use client";
import { useEffect, useRef, useState } from "react";
import { createWorker, Worker } from "tesseract.js";

type Level = "light" | "medium" | "hard";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

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
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        const v = videoRef.current!;
        v.srcObject = stream;
        v.muted = true;
        // wait for metadata to be ready before playing, ensure videoWidth/Height
        v.onloadedmetadata = async () => {
          try {
            await v.play();
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
              setDebugInfo(`✏️ 压力: ${p.toFixed(3)} | 降级到: ${currentLevel} | 当前最高: ${maxLevelInSession}`);
            }
          }, 500); // 0.5秒稳定时间
          
          console.log('[Pressure] 开始降级计时到:', currentLevel);
        }
        
        // 显示降级倒计时
        const elapsed = Date.now() - stableStartTime;
        const remaining = Math.max(0, 500 - elapsed);
        setDebugInfo(`✏️ 压力: ${p.toFixed(3)} | 当前: ${currentLevel} | 最高: ${maxLevelInSession} | 降级倒计时: ${(remaining/1000).toFixed(1)}s`);
        
      } else {
        // 压力回升，取消降级
        if (pendingDowngradeLevel) {
          clearTimeout(downgradeTimer);
          pendingDowngradeLevel = null;
          stableStartTime = 0;
          console.log('[Pressure] 压力回升，取消降级');
        }
        
        // 正常显示
        setDebugInfo(`✏️ 压力: ${p.toFixed(3)} | 当前: ${currentLevel} | 最高: ${maxLevelInSession}`);
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

  // 4) 点按（PointerUp 更稳）→ 裁 ROI → OCR → 调 LLM
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
    
    // 首先计算绘制区域的边界
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
        const margin = 10; // 边距
        bounds = {
          left: Math.max(0, Math.min(...xs) - margin),
          top: Math.max(0, Math.min(...ys) - margin),
          width: Math.max(...xs) - Math.min(...xs) + margin * 2,
          height: Math.max(...ys) - Math.min(...ys) + margin * 2
        };
        console.log('[Drawing] 真实绘制 (距离≥30px)，计算边界:', bounds, '总距离:', totalDistance.toFixed(1));
      }
      
      setSelectionBounds(bounds);
      console.log('[Drawing] ✅ 选择区域已设置:', bounds);
    } else {
      console.log('[Drawing] ⚠️ 没有绘制路径，清除选择区域');
      setSelectionBounds(null);
    }
    
    setDebugInfo(`点击检测: ${e.pointerType} 压力:${e.pressure?.toFixed(2) || 'N/A'}`);
    
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
      setAnswer("视频还未就绪，请等待..."); 
      console.log('[Click] 视频未就绪');
      return; 
    }
    if (!ocrReady || !worker) { 
      setAnswer("OCR 引擎还在加载中，请稍候..."); 
      console.log('[Click] OCR 未就绪');
      return; 
    }

    const v = video; // 使用重命名的变量
    if (!v.videoWidth || !v.videoHeight) {
      setAnswer("等待视频尺寸信息...");
      console.log('[Click] 视频尺寸未就绪:', { videoWidth: v.videoWidth, videoHeight: v.videoHeight });
      return;
    }

    // 显示正在处理的提示，确认事件已触发
    setAnswer(`正在 OCR 识别... (压力等级: ${level})`);
    console.log('[Click] 开始 OCR 处理');

    // 计算点击点在视频帧中的坐标
    // 使用overlay的坐标系，与绘制路径保持一致
    const overlayRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((e.clientX - overlayRect.left) / overlayRect.width) * v.videoWidth;
    const y = ((e.clientY - overlayRect.top) / overlayRect.height) * v.videoHeight;

    console.log('[Click] 坐标计算:', {
      click: { x: e.clientX, y: e.clientY },
      overlayRect: { width: overlayRect.width, height: overlayRect.height },
      video: { width: v.videoWidth, height: v.videoHeight },
      normalized: { x, y }
    });

    // 确定OCR区域
    let ocrLeft, ocrTop, ocrWidth, ocrHeight;
    
    console.log('[OCR] 选择区域检查:', {
      hasSelectionBounds: !!selectionBounds,
      selectionBounds,
      overlayRect: { width: overlayRect.width, height: overlayRect.height },
      videoDisplaySize: { width: v.clientWidth, height: v.clientHeight },
      videoNaturalSize: { width: v.videoWidth, height: v.videoHeight }
    });
    
    if (selectionBounds && selectionBounds.width > 5 && selectionBounds.height > 5) {
      // 计算video在overlay中的实际显示区域（考虑object-contain的影响）
      const videoAspect = v.videoWidth / v.videoHeight;
      const overlayAspect = overlayRect.width / overlayRect.height;
      
      let videoDisplayWidth, videoDisplayHeight, videoOffsetX, videoOffsetY;
      
      if (videoAspect > overlayAspect) {
        // 视频更宽，以宽度为准
        videoDisplayWidth = overlayRect.width;
        videoDisplayHeight = overlayRect.width / videoAspect;
        videoOffsetX = 0;
        videoOffsetY = (overlayRect.height - videoDisplayHeight) / 2;
      } else {
        // 视频更高，以高度为准
        videoDisplayHeight = overlayRect.height;
        videoDisplayWidth = overlayRect.height * videoAspect;
        videoOffsetX = (overlayRect.width - videoDisplayWidth) / 2;
        videoOffsetY = 0;
      }
      
      console.log('[OCR] 视频显示计算:', {
        videoDisplayWidth, videoDisplayHeight, videoOffsetX, videoOffsetY,
        videoAspect, overlayAspect
      });
      
      // 转换选择区域坐标到视频坐标系
      const relativeLeft = (selectionBounds.left - videoOffsetX) / videoDisplayWidth;
      const relativeTop = (selectionBounds.top - videoOffsetY) / videoDisplayHeight;
      const relativeWidth = selectionBounds.width / videoDisplayWidth;
      const relativeHeight = selectionBounds.height / videoDisplayHeight;
      
      ocrLeft = Math.max(0, Math.floor(relativeLeft * v.videoWidth));
      ocrTop = Math.max(0, Math.floor(relativeTop * v.videoHeight));
      ocrWidth = Math.min(v.videoWidth - ocrLeft, Math.floor(relativeWidth * v.videoWidth));
      ocrHeight = Math.min(v.videoHeight - ocrTop, Math.floor(relativeHeight * v.videoHeight));
      
      console.log('[OCR] ✅ 使用绘制区域 (修正坐标):', { 
        ocrLeft, ocrTop, ocrWidth, ocrHeight, 
        selectionBounds,
        relative: { relativeLeft, relativeTop, relativeWidth, relativeHeight }
      });
    } else {
      // 备用：使用点击点周围的固定区域
      const ROI_W = 600, ROI_H = 200;
      ocrLeft = Math.max(0, Math.floor(x - ROI_W / 2));
      ocrTop = Math.max(0, Math.floor(y - ROI_H / 2));
      ocrWidth = Math.min(v.videoWidth - ocrLeft, ROI_W);
      ocrHeight = Math.min(v.videoHeight - ocrTop, ROI_H);
      console.log('[OCR] ⚠️ 使用固定区域 (备用):', { 
        reason: selectionBounds ? '区域太小' : '没有选择区域',
        ocrLeft, ocrTop, ocrWidth, ocrHeight, 
        selectionBounds 
      });
    }

    // 把当前帧画到离屏 canvas
    const canvas = document.createElement("canvas");
    canvas.width = ocrWidth; 
    canvas.height = ocrHeight;
    const ctx = canvas.getContext("2d")!;
    
    console.log('[Click] Canvas 创建完成，开始绘制...', {
      canvasSize: { width: canvas.width, height: canvas.height },
      roiPosition: { left: ocrLeft, top: ocrTop, width: ocrWidth, height: ocrHeight },
      videoSize: { width: v.videoWidth, height: v.videoHeight },
      videoCurrentTime: v.currentTime,
      videoReadyState: v.readyState,
      videoPlaying: !v.paused && !v.ended && v.readyState > 2
    });

    try {
      // 尝试绘制视频帧到canvas
      ctx.drawImage(v, ocrLeft, ocrTop, ocrWidth, ocrHeight, 0, 0, ocrWidth, ocrHeight);
      console.log('[Click] 视频帧绘制完成');
      
      // 检查canvas是否真的有内容
      const imageData = ctx.getImageData(0, 0, Math.min(10, ocrWidth), Math.min(10, ocrHeight));
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
            setAnswer("错误：视频未完全加载，请等待视频就绪后重试");
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
            setAnswer("错误：iPad上无法从视频获取任何像素数据，可能是Safari安全限制");
            setCapturedImage("");
            return;
          }
          
          // 从完整视频帧中提取ROI
          const roiImageData = tempCtx.getImageData(ocrLeft, ocrTop, ocrWidth, ocrHeight);
          ctx.putImageData(roiImageData, 0, 0);
          
          console.log('[Click] iPad备用捕获成功');
          
        } catch (fallbackError: any) {
          console.error('[Click] iPad备用捕获也失败:', fallbackError);
          setAnswer(`错误：所有视频捕获方法都失败 - ${fallbackError.message || String(fallbackError)}`);
          setCapturedImage("");
          return;
        }
      }
      
    } catch (drawError: any) {
      console.error('[Click] 绘制视频帧到canvas时出错:', drawError);
      setAnswer(`错误：无法将视频帧绘制到canvas - ${drawError.message || String(drawError)}`);
      setCapturedImage("");
      return;
    }

    console.log('[Click] Canvas 创建完成，开始 OCR...', {
      canvasSize: { width: canvas.width, height: canvas.height },
      roiPosition: { left: ocrLeft, top: ocrTop, width: ocrWidth, height: ocrHeight },
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
      setAnswer(`错误：Canvas转换为DataURL失败 - ${toDataURLError.message || String(toDataURLError)}`);
      setCapturedImage("");
      return;
    }
    
    // 保存捕获的图像用于显示
    setCapturedImage(dataURL);

    try {
      const { data: { text } } = await worker.recognize(canvas);
      const picked = text.trim().slice(0, 400);
      console.log('[OCR] 识别结果:', { 
        originalLength: text.length, 
        trimmedLength: picked.length, 
        text: picked 
      });
      
      setAnswer(`正在调用 LLM... (压力等级: ${level})\n\n识别到的文本: ${picked || "(未识别到文本)"}`);
      if(picked.length === 0) {
        setAnswer("识别到的文本为空 - 可能是图像质量问题或区域没有文字\n\n请查看下方的捕获图像");
        console.log('[OCR] 文本为空，可能原因：图像质量、光线、角度、或该区域确实没有文字');
        return;
      }

      // 调 LLM
      const resp = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: picked || "No text", level }),
      });

      console.log('[LLM] API 调用状态:', resp.status);

      if (!resp.ok) {
        throw new Error(`LLM API 错误: ${resp.status}`);
      }

      const data = await resp.json();
      const content = data.content || "No response";
      
      console.log('[LLM] 响应完成:', { contentLength: content.length });
      setAnswer(content);
    } catch (err:any) {
      console.error(err);
      setAnswer("Error: " + (err?.message || String(err)));
    }
  };

  return (
    <main className="min-h-screen bg-gray-50 p-4">
      <h1 className="text-xl font-semibold mb-3">PressureLens — Web MVP (Next.js)</h1>

      <div className="mb-2 text-sm text-gray-600">
        Video: {videoReady ? "✅ ready" : "⏳ loading"} ·
        OCR: {ocrReady ? "✅ ready" : "⏳ loading"} ·
        Level: <b className={
          level==="light" ? "text-green-600" :
          level==="medium" ? "text-amber-600" : "text-red-600"
        }>{level}</b>
        {isUsingPen && currentPressure > 0 && (
          <span className="ml-2 text-blue-600">
            ✏️ Apple Pencil 压力: <b>{currentPressure.toFixed(3)}drawingPath.length{drawingPath.length}</b>
          </span>
        )}
        {debugInfo && <div className="mt-1 text-xs text-blue-600">🔍 {debugInfo}</div>}
        {deviceInfo && <div className="mt-1 text-xs text-purple-600">📱 {deviceInfo}</div>}
      </div>

      {/* 压力条显示 */}
      {(
        <div className="mb-3 p-2 bg-gray-100 rounded-lg">
          <div className="text-xs text-gray-600 mb-1">压力条</div>
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
            <span>轻 (0-33%)</span>
            <span>中 (33-66%)</span>
            <span>重 (66-100%)</span>
          </div>
        </div>
      )}

      {/* Apple Pencil 1代手动level切换 */}
      <div className="mb-3 flex gap-2">
        <span className="text-sm text-gray-600">压力等级:</span>
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
              {l === 'light' ? '轻 (一句话)' : l === 'medium' ? '中 (正常)' : '重 (详细+建议)'}
            </button>
          );
        })}
      </div>

      <div className="relative w-full max-w-3xl aspect-[4/3] rounded-xl overflow-hidden border bg-black">
        <video 
          ref={videoRef} 
          className="w-full h-full object-contain" 
          playsInline 
          style={{
            touchAction: 'manipulation',
            pointerEvents: 'none' // 禁用video上的事件，只在overlay上处理
          }}
        />
        {/* 盖在视频上用于接收 Pointer 事件（z-10 + pointerUp） */}
        <div
          ref={overlayRef}
          onPointerUp={(e) => {
            console.log('[Events] PointerUp - 主要事件处理器');
            onPointerUp(e);
          }}
          onPointerDown={(e) => {
            console.log('[Events] PointerDown:', {
              type: e.pointerType,
              pressure: e.pressure,
              x: e.clientX,
              y: e.clientY,
              isPrimary: e.isPrimary
            });
            setDebugInfo(`按下: ${e.pointerType} 压力:${e.pressure?.toFixed(2) || 'N/A'} 主要:${e.isPrimary}`);
            e.preventDefault();
          }}
          onTouchStart={(e) => {
            console.log('[Events] TouchStart:', {
              touchesCount: e.touches.length,
              target: e.target,
              currentTarget: e.currentTarget
            });
            setDebugInfo(`触摸开始: ${e.touches.length} 个触点`);
            // 不阻止默认行为，让 pointer 事件也能触发
          }}
          onTouchEnd={(e) => {
            console.log('[Events] TouchEnd - 备用处理');
            setDebugInfo(`触摸结束: 正在处理...`);
            
            // 备用处理：如果pointer事件没有触发
            if (e.changedTouches.length > 0) {
              const touch = e.changedTouches[0];
              console.log('[Events] 使用 TouchEnd 备用处理:', {
                x: touch.clientX,
                y: touch.clientY
              });
              
              const syntheticEvent = {
                currentTarget: e.currentTarget,
                clientX: touch.clientX,
                clientY: touch.clientY,
                pointerType: 'touch',
                pressure: 0.5  // 触摸事件没有真实压力值，使用固定值
              } as any;
              
              // 延迟执行，避免与pointer事件冲突
              setTimeout(() => {
                console.log('[Events] 执行TouchEnd备用处理');
                onPointerUp(syntheticEvent);
              }, 30);
            }
          }}
          onMouseDown={(e) => {
            console.log('[Events] MouseDown:', { x: e.clientX, y: e.clientY });
          }}
          onMouseUp={(e) => {
            console.log('[Events] MouseUp - 鼠标备用处理');
            setDebugInfo(`鼠标释放: (${e.clientX}, ${e.clientY})`);
            
            // 只在非触摸设备上使用鼠标事件
            if (navigator.maxTouchPoints === 0) {
              const syntheticEvent = {
                currentTarget: e.currentTarget,
                clientX: e.clientX,
                clientY: e.clientY,
                pointerType: 'mouse',
                pressure: 1.0
              } as any;
              
              setTimeout(() => {
                console.log('[Events] 执行鼠标备用处理');
                onPointerUp(syntheticEvent);
              }, 10);
            }
          }}
          className="absolute inset-0 z-10 cursor-crosshair select-none"
          style={{ 
            touchAction: 'manipulation', // 改为 manipulation，允许基本触摸但禁用双击缩放等
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
            WebkitTapHighlightColor: 'transparent',
            pointerEvents: 'auto' // 确保指针事件可以触发
          }}
          title="用 Apple Pencil 点击或手指轻触来选择区域"
        >
          {/* 绘制路径可视化 */}
          {drawingPath.length > 1 && (() => {
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
          
          {/* 当前绘制点显示 */}
          {isPressed && drawingPath.length > 0 && (
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
                opacity: 0.2,
       
              }}
            />
          )}
        </div>
      </div>

      <div className="mt-4 p-3 rounded-lg border bg-white max-w-3xl whitespace-pre-wrap text-sm">
        <div className="font-medium mb-1">Response</div>
        {answer || "Tap the video to OCR the region under your pen, then call LLM."}
      </div>

      {/* 显示捕获的图像 */}
      {capturedImage && (
        <div className="mt-4 p-3 rounded-lg border bg-white max-w-3xl">
          <div className="font-medium mb-2">📸 捕获的图像 (用于OCR)</div>
          <img 
            src={capturedImage} 
            alt="Captured ROI for OCR" 
            className="border rounded max-w-full h-auto"
            style={{ maxHeight: '200px' }}
          />
          <div className="text-xs text-gray-500 mt-1">
            这是系统截取用于OCR的图像区域。如果图像模糊或没有文字，OCR就会失败。
          </div>
          {selectionBounds && (
            <div className="text-xs text-blue-600 mt-1">
              选择区域: {selectionBounds.width.toFixed(0)}×{selectionBounds.height.toFixed(0)}px 
              (位置: {selectionBounds.left.toFixed(0)}, {selectionBounds.top.toFixed(0)})
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
          🧪 测试 OCR
        </button>
        
        <button
          onClick={() => {
            setDebugInfo('');
            setAnswer('');
            console.log('[Test] 清除调试信息');
          }}
          className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 text-sm"
        >
          清除
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
            ▶️ 恢复视频
          </button>
        )}
      </div>

      {/* iPad 事件测试区域 */}
      <div className="mt-4 p-4 border border-dashed border-gray-300 rounded-lg bg-yellow-50">
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
      </div>

      <p className="text-xs text-gray-500 mt-3">
        Tip: iPad Safari 需要 HTTPS 才能访问相机。你正在用 Cloudflare Tunnel 就没问题。
      </p>
    </main>
  );
}
