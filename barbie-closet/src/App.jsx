import { useEffect, useRef, useState } from "react";
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { removeBackground } from "@imgly/background-removal";
import { TopRenderer, prepareGarment } from "./tryOn";
import "./App.css";

const SWIPE_DISTANCE = 0.12;   // how far a hand must travel (fraction of the frame)
const GESTURE_COOLDOWN = 900;  // ms between gestures

function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const poseLandmarkerRef = useRef(null);
  const animationRef = useRef(null);

  const leftHandHistoryRef = useRef([]);
  const rightHandHistoryRef = useRef([]);
  const leftFootLiftedRef = useRef(false);
  const rightFootLiftedRef = useRef(false);
  const leftFootRestYRef = useRef(null);
  const rightFootRestYRef = useRef(null);
  const lastGestureTimeRef = useRef(0);

  // closets live in refs (the camera loop reads them every frame);
  // matching state is only used to re-render the page
  const topsRef = useRef([]);
  const bottomsRef = useRef([]);
  const topIndexRef = useRef(0);
  const bottomIndexRef = useRef(0);
  const imagesRef = useRef({});    // id -> <img>
  const garmentsRef = useRef({});  // id -> analysed top (torso + sleeves)

  // live fitting options, read by the camera loop
  const optsRef = useRef({ fit: 1, length: 1, clip: true, dots: false });

  const [status, setStatus] = useState("Loading body tracking...");
  const [gesture, setGesture] = useState("Waiting for gesture...");
  const [topNumber, setTopNumber] = useState(0);
  const [bottomNumber, setBottomNumber] = useState(0);
  const [tops, setTops] = useState([]);
  const [bottoms, setBottoms] = useState([]);
  const [clothingType, setClothingType] = useState("top");
  const [isRemovingBackground, setIsRemovingBackground] = useState(false);

  const [fit, setFit] = useState(1);
  const [length, setLength] = useState(1);
  const [clip, setClip] = useState(true);
  const [dots, setDots] = useState(false);

  // small helpers so tops and bottoms share one code path
  const closetOf = (type) =>
    type === "top"
      ? { listRef: topsRef, idxRef: topIndexRef, setList: setTops, setIdx: setTopNumber }
      : { listRef: bottomsRef, idxRef: bottomIndexRef, setList: setBottoms, setIdx: setBottomNumber };

  function changeItem(type, direction, time, icon) {
    const { listRef, idxRef, setIdx } = closetOf(type);
    const total = listRef.current.length;

    if (total === 0) {
      setGesture(type === "top" ? "👚 ADD A TOP FIRST" : "👖 ADD A BOTTOM FIRST");
    } else {
      const next = (idxRef.current + direction + total) % total;
      idxRef.current = next;
      setIdx(next);
      setGesture(`${icon} ${direction > 0 ? "NEXT" : "PREVIOUS"} ${type.toUpperCase()} — ${next + 1} OF ${total}`);
    }
    lastGestureTimeRef.current = time;
  }

  function addItem(type, item) {
    const { listRef, idxRef, setList, setIdx } = closetOf(type);
    const updated = [...listRef.current, item];
    listRef.current = updated;
    setList(updated);
    if (updated.length === 1) {
      idxRef.current = 0;
      setIdx(0);
    }
  }

  function removeItem(type, id) {
    const { listRef, idxRef, setList, setIdx } = closetOf(type);
    const item = listRef.current.find((piece) => piece.id === id);
    if (item) {
      URL.revokeObjectURL(item.url);
      delete imagesRef.current[id];
      delete garmentsRef.current[id];
    }
    const updated = listRef.current.filter((piece) => piece.id !== id);
    listRef.current = updated;
    setList(updated);

    let index = idxRef.current;
    if (updated.length === 0) index = 0;
    else if (index >= updated.length) index = updated.length - 1;
    idxRef.current = index;
    setIdx(index);

    setGesture(type === "top" ? "👚 TOP REMOVED" : "👖 BOTTOM REMOVED");
  }

  // =====================================================
  // CAMERA + MEDIAPIPE
  // =====================================================

  useEffect(() => {
    let stream;
    let stopped = false;
    let lastVideoTime = -1;
    let maskFrame = 0;
    const renderer = new TopRenderer();

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720 },
          audio: false,
        });

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;

        await new Promise((resolve) => {
          video.onloadeddata = resolve;
        });
        await video.play();

        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );

        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: false, // lets the shirt follow your real body outline
        });

        if (stopped) {
          poseLandmarker.close();
          return;
        }

        poseLandmarkerRef.current = poseLandmarker;
        setStatus("Body + clothing tracking active ✓");
        detectPose();
      } catch (error) {
        console.error(error);
        setStatus("Could not start body tracking");
      }
    }

    // ---------- gestures ----------

    function saveHandPosition(historyRef, wrist, time) {
      if (!wrist || wrist.visibility < 0.5) {
        historyRef.current = [];
        return;
      }
      historyRef.current.push({ x: wrist.x, y: wrist.y, time });
      while (historyRef.current.length > 0 && time - historyRef.current[0].time > 450) {
        historyRef.current.shift();
      }
    }

    // direction: +1 = hand travelled right, -1 = hand travelled left
    function isSwipe(history, direction) {
      if (history.length < 4) return false;
      const start = history[0];
      const end = history[history.length - 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      return dx * direction > SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.3;
    }

    function checkTopGestures(time) {
      if (time - lastGestureTimeRef.current < GESTURE_COOLDOWN) return;

      // LEFT HAND -> NEXT TOP, RIGHT HAND <- PREVIOUS TOP
      let direction = 0;

if (isSwipe(leftHandHistoryRef.current, -1)) direction = 1;
else if (isSwipe(rightHandHistoryRef.current, 1)) direction = -1;;
      if (!direction) return;

      changeItem("top", direction, time, direction > 0 ? "🫲" : "🫱");
      leftHandHistoryRef.current = [];
      rightHandHistoryRef.current = [];
    }

    // returns true when the foot completes a lift-and-drop
    function footStomped(foot, restRef, liftedRef) {
      if (restRef.current === null) {
        restRef.current = foot.y;
        return false;
      }
      if (!liftedRef.current) restRef.current = restRef.current * 0.97 + foot.y * 0.03;
      if (foot.y < restRef.current - 0.055) liftedRef.current = true;
      if (liftedRef.current && foot.y > restRef.current - 0.025) {
        liftedRef.current = false;
        restRef.current = foot.y;
        return true;
      }
      return false;
    }

    function checkFootStomps(landmarks, time) {
      const leftFoot = landmarks[27];
      const rightFoot = landmarks[28];
      if (!leftFoot || !rightFoot || leftFoot.visibility < 0.5 || rightFoot.visibility < 0.5) return;

      const rightDone = footStomped(rightFoot, rightFootRestYRef, rightFootLiftedRef);
      const leftDone = footStomped(leftFoot, leftFootRestYRef, leftFootLiftedRef);

      if (time - lastGestureTimeRef.current <= GESTURE_COOLDOWN) return;
      if (rightDone) changeItem("bottom", 1, time, "🦶");
      else if (leftDone) changeItem("bottom", -1, time, "🦶");
    }

    // ---------- drawing ----------

    function drawBottom(ctx, points) {
    
  const list = bottomsRef.current;
  if (list.length === 0) return;

  const item = list[bottomIndexRef.current % list.length];
  const image = item && imagesRef.current[item.id];

  if (!image) return;

  // Body landmarks
  const leftHip = points[23];
  const rightHip = points[24];

  const leftKnee = points[25];
  const rightKnee = points[26];

  const leftAnkle = points[27];
  const rightAnkle = points[28];

  if (
    !leftHip ||
    !rightHip ||
    !leftKnee ||
    !rightKnee ||
    !leftAnkle ||
    !rightAnkle
  ) {
    return;
  }

  if (
    leftHip.v < 0.4 ||
    rightHip.v < 0.4 ||
    leftKnee.v < 0.35 ||
    rightKnee.v < 0.35
  ) {
    return;
  }

  const imgW = image.naturalWidth || image.width;
  const imgH = image.naturalHeight || image.height;

  if (!imgW || !imgH) return;

  // --------------------------------------------------
  // BODY SIZE
  // --------------------------------------------------

  const hipCenter = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
  };

  const hipWidth = Math.hypot(
    rightHip.x - leftHip.x,
    rightHip.y - leftHip.y
  );

  if (hipWidth < 10) return;

  // Make waistband slightly wider than detected hips
  const waistWidth = hipWidth * 1.45;

  // --------------------------------------------------
  // SOURCE IMAGE SECTIONS
  // --------------------------------------------------

  // Top of uploaded pants
  const sourceTop = imgH * 0.02;

  // Approximate point where the two pant legs separate
  const sourceCrotch = imgH * 0.34;

  const sourceBottom = imgH * 0.98;

  const sourceMiddle = imgW / 2;

  // --------------------------------------------------
  // WAIST / HIP SECTION
  // --------------------------------------------------

  const waistTopY = hipCenter.y - hipWidth * 0.12;

  const crotchCenter = {
    x: (leftKnee.x + rightKnee.x) / 2,
    y:
      hipCenter.y +
      Math.min(
        leftKnee.y - hipCenter.y,
        rightKnee.y - hipCenter.y
      ) *
        0.42,
  };

  ctx.save();

  ctx.beginPath();

  ctx.moveTo(
    hipCenter.x - waistWidth / 2,
    waistTopY
  );

  ctx.lineTo(
    hipCenter.x + waistWidth / 2,
    waistTopY
  );

  ctx.lineTo(
    rightHip.x + hipWidth * 0.2,
    crotchCenter.y
  );

  ctx.lineTo(
    crotchCenter.x,
    crotchCenter.y + hipWidth * 0.1
  );

  ctx.lineTo(
    leftHip.x - hipWidth * 0.2,
    crotchCenter.y
  );

  ctx.closePath();
  ctx.clip();

  ctx.drawImage(
    image,

    0,
    sourceTop,
    imgW,
    sourceCrotch - sourceTop,

    hipCenter.x - waistWidth / 2,
    waistTopY,
    waistWidth,
    crotchCenter.y - waistTopY + hipWidth * 0.15
  );

  ctx.restore();

  // --------------------------------------------------
  // DRAW A SINGLE PANT LEG
  // --------------------------------------------------

  function drawPantLeg(
    hip,
    knee,
    ankle,
    sourceX,
    sourceWidth
  ) {
    // Upper leg direction
    const upperDX = knee.x - hip.x;
    const upperDY = knee.y - hip.y;

    const upperLength =
      Math.hypot(upperDX, upperDY) || 1;

    const upperNormal = {
      x: -upperDY / upperLength,
      y: upperDX / upperLength,
    };

    // Lower leg direction
    const lowerDX = ankle.x - knee.x;
    const lowerDY = ankle.y - knee.y;

    const lowerLength =
      Math.hypot(lowerDX, lowerDY) || 1;

    const lowerNormal = {
      x: -lowerDY / lowerLength,
      y: lowerDX / lowerLength,
    };

    // Pants widths
    const hipHalfWidth = hipWidth * 0.34;
    const kneeHalfWidth = hipWidth * 0.25;
    const ankleHalfWidth = hipWidth * 0.19;

    // Upper leg corners
    const hipA = {
      x: hip.x + upperNormal.x * hipHalfWidth,
      y: hip.y + upperNormal.y * hipHalfWidth,
    };

    const hipB = {
      x: hip.x - upperNormal.x * hipHalfWidth,
      y: hip.y - upperNormal.y * hipHalfWidth,
    };

    const kneeUpperA = {
      x: knee.x + upperNormal.x * kneeHalfWidth,
      y: knee.y + upperNormal.y * kneeHalfWidth,
    };

    const kneeUpperB = {
      x: knee.x - upperNormal.x * kneeHalfWidth,
      y: knee.y - upperNormal.y * kneeHalfWidth,
    };

    // Lower leg corners
    const kneeLowerA = {
      x: knee.x + lowerNormal.x * kneeHalfWidth,
      y: knee.y + lowerNormal.y * kneeHalfWidth,
    };

    const kneeLowerB = {
      x: knee.x - lowerNormal.x * kneeHalfWidth,
      y: knee.y - lowerNormal.y * kneeHalfWidth,
    };

    const ankleA = {
      x: ankle.x + lowerNormal.x * ankleHalfWidth,
      y: ankle.y + lowerNormal.y * ankleHalfWidth,
    };

    const ankleB = {
      x: ankle.x - lowerNormal.x * ankleHalfWidth,
      y: ankle.y - lowerNormal.y * ankleHalfWidth,
    };

    // ================================================
    // UPPER HALF OF PANT LEG
    // ================================================

    ctx.save();

    ctx.beginPath();

    ctx.moveTo(hipA.x, hipA.y);
    ctx.lineTo(hipB.x, hipB.y);
    ctx.lineTo(kneeUpperB.x, kneeUpperB.y);
    ctx.lineTo(kneeUpperA.x, kneeUpperA.y);

    ctx.closePath();
    ctx.clip();

    const upperMinX = Math.min(
      hipA.x,
      hipB.x,
      kneeUpperA.x,
      kneeUpperB.x
    );

    const upperMaxX = Math.max(
      hipA.x,
      hipB.x,
      kneeUpperA.x,
      kneeUpperB.x
    );

    const upperMinY = Math.min(
      hipA.y,
      hipB.y,
      kneeUpperA.y,
      kneeUpperB.y
    );

    const upperMaxY = Math.max(
      hipA.y,
      hipB.y,
      kneeUpperA.y,
      kneeUpperB.y
    );

    ctx.drawImage(
      image,

      sourceX,
      sourceCrotch,
      sourceWidth,
      (sourceBottom - sourceCrotch) * 0.5,

      upperMinX,
      upperMinY,
      Math.max(1, upperMaxX - upperMinX),
      Math.max(1, upperMaxY - upperMinY)
    );

    ctx.restore();

    // ================================================
    // LOWER HALF OF PANT LEG
    // ================================================

    ctx.save();

    ctx.beginPath();

    ctx.moveTo(kneeLowerA.x, kneeLowerA.y);
    ctx.lineTo(kneeLowerB.x, kneeLowerB.y);
    ctx.lineTo(ankleB.x, ankleB.y);
    ctx.lineTo(ankleA.x, ankleA.y);

    ctx.closePath();
    ctx.clip();

    const lowerMinX = Math.min(
      kneeLowerA.x,
      kneeLowerB.x,
      ankleA.x,
      ankleB.x
    );

    const lowerMaxX = Math.max(
      kneeLowerA.x,
      kneeLowerB.x,
      ankleA.x,
      ankleB.x
    );

    const lowerMinY = Math.min(
      kneeLowerA.y,
      kneeLowerB.y,
      ankleA.y,
      ankleB.y
    );

    const lowerMaxY = Math.max(
      kneeLowerA.y,
      kneeLowerB.y,
      ankleA.y,
      ankleB.y
    );

    ctx.drawImage(
      image,

      sourceX,
      sourceCrotch +
        (sourceBottom - sourceCrotch) * 0.48,

      sourceWidth,
      (sourceBottom - sourceCrotch) * 0.52,

      lowerMinX,
      lowerMinY,
      Math.max(1, lowerMaxX - lowerMinX),
      Math.max(1, lowerMaxY - lowerMinY)
    );

    ctx.restore();
  }

  // --------------------------------------------------
  // LEFT + RIGHT LEGS
  // --------------------------------------------------

  drawPantLeg(
    leftHip,
    leftKnee,
    leftAnkle,
    0,
    sourceMiddle
  );

  drawPantLeg(
    rightHip,
    rightKnee,
    rightAnkle,
    sourceMiddle,
    imgW - sourceMiddle
  );
}

    function drawTracking(ctx, points) {
      ctx.fillStyle = "#ff1493";
      ctx.strokeStyle = "white";
      ctx.lineWidth = 4;
      [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28].forEach((index) => {
        const p = points[index];
        if (!p) return;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    }

    // ---------- main loop ----------

   function detectPose() {
  if (stopped) return;

  const video = videoRef.current;
  const canvas = canvasRef.current;
  const pose = poseLandmarkerRef.current;

  if (!video || !canvas || !pose) {
    animationRef.current = requestAnimationFrame(detectPose);
    return;
  }

  if (
    video.readyState >= 2 &&
    video.currentTime !== lastVideoTime
  ) {
    lastVideoTime = video.currentTime;

    if (
      canvas.width !== video.videoWidth ||
      canvas.height !== video.videoHeight
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    const ctx = canvas.getContext("2d");
    const time = performance.now();

    try {
      // Use the original synchronous MediaPipe detection
      const result = pose.detectForVideo(video, time);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const landmarks =
        result.landmarks && result.landmarks[0];

      if (!landmarks) {
        renderer.reset();
      } else {
        // HAND MOTION
        saveHandPosition(
          leftHandHistoryRef,
          landmarks[15],
          time
        );

        saveHandPosition(
          rightHandHistoryRef,
          landmarks[16],
          time
        );

        // FOOT MOTION
        checkFootStomps(landmarks, time);

        // HAND SWIPES
        checkTopGestures(time);

        // Convert landmarks to smooth pixel coordinates
        const points = renderer.track(
          landmarks,
          canvas.width,
          canvas.height
        );

        // Draw bottoms
        drawBottom(ctx, points);

        // Draw tops using the new renderer
        const currentTops = topsRef.current;

        if (currentTops.length > 0) {
          const item =
            currentTops[
              topIndexRef.current % currentTops.length
            ];

          const garment =
            item && garmentsRef.current[item.id];

          if (garment) {
            renderer.drawTop(
              ctx,
              video,
              points,
              garment,
              {
                ...optsRef.current,
                clip: false,
              }
            );
          }
        }

        // Tracking dots
        if (optsRef.current.dots) {
          drawTracking(ctx, points);
        }
      }
    } catch (error) {
      console.error("Pose detection/draw error:", error);
    }
  }

  animationRef.current =
    requestAnimationFrame(detectPose);
}
    

    startCamera();

    return () => {
      stopped = true;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (poseLandmarkerRef.current) {
        poseLandmarkerRef.current.close();
        poseLandmarkerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // =====================================================
  // UPLOAD + BACKGROUND REMOVAL
  // =====================================================

  async function handleImageUpload(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    setIsRemovingBackground(true);
    const selectedType = clothingType;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith("image/")) continue;

        setGesture(`✨ PROCESSING ${i + 1} OF ${files.length}...`);

        const transparentBlob = await removeBackground(file, {
          output: { format: "image/png", quality: 1, type: "foreground" },
        });
        const url = URL.createObjectURL(transparentBlob);

        // wait for the picture before it can be worn
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
          image.src = url;
        });

        const item = {
          id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
          url,
          name: file.name,
          type: selectedType,
        };

        imagesRef.current[item.id] = image;
        if (selectedType === "top") {
          // finds the torso panel and the sleeves so the shirt can be fitted to a body
          garmentsRef.current[item.id] = prepareGarment(image);
        }
        addItem(selectedType, item);
      }

      setGesture(`✨ ${files.length} ${selectedType === "top" ? "TOP(S)" : "BOTTOM(S)"} ADDED`);
    } catch (error) {
      console.error("Background removal error:", error);
      setGesture("❌ BACKGROUND REMOVAL FAILED — TRY AGAIN");
    } finally {
      setIsRemovingBackground(false);
      event.target.value = "";
    }
  }

  // =====================================================
  // PAGE
  // =====================================================

  function setOption(name, value) {
    optsRef.current = { ...optsRef.current, [name]: value };
  }

  function closetSection({ type, icon, label, items, current }) {
    if (items.length === 0) return null;
    return (
      <div className="upload-preview">
        <div className="preview-title">
          {icon} YOUR {label} ({items.length})
        </div>

        {items.map((item, index) => (
          <div
            key={item.id}
            style={{ marginBottom: "22px", paddingBottom: "18px", borderBottom: "2px solid #ffd1e8" }}
          >
            <div className="preview-image-container">
              <img src={item.url} alt={`${type} ${index + 1}`} className="preview-image" />
            </div>

            <div className="preview-type">
              {index === current
                ? `✨ WEARING ${type.toUpperCase()} ${index + 1}`
                : `${icon} ${type.toUpperCase()} ${index + 1}`}
            </div>

            <button type="button" className="remove-image-button" onClick={() => removeItem(type, item.id)}>
              REMOVE
            </button>
          </div>
        ))}
      </div>
    );
  }

  const sliderStyle = { width: "100%", accentColor: "#ff1493" };
  const labelStyle = { display: "block", fontWeight: "bold", color: "#d6006e", margin: "10px 0 2px" };

  return (
    <div className="app">
      <header className="main-header">
        <h1>♡ MOTION CLOSET ♡</h1>
        <p>Your body. Your closet. Your style.</p>
      </header>

      <div className="status">{status}</div>
      <div className="gesture-display">{gesture}</div>

      <div className="top-display">
        👚 CURRENT TOP: {tops.length === 0 ? "NONE" : `${topNumber + 1} / ${tops.length}`}
      </div>
      <div className="bottom-display">
        👖 CURRENT BOTTOM: {bottoms.length === 0 ? "NONE" : `${bottomNumber + 1} / ${bottoms.length}`}
      </div>

      {/* CAMERA */}
      <div className="camera-frame">
        <div className="camera-container">
          <video ref={videoRef} autoPlay playsInline muted className="camera" />
          <canvas ref={canvasRef} className="pose-canvas" />
        </div>
        <div className="camera-label">✦ LIVE FITTING ROOM ✦</div>
      </div>

      {/* FIT CONTROLS */}
      <section style={{ maxWidth: 520, margin: "18px auto", padding: "0 16px" }}>
        <label style={labelStyle}>
          Fit — {fit < 0.97 ? "snug" : fit > 1.05 ? "loose" : "regular"}
          <input
            type="range" min="0.85" max="1.35" step="0.01" value={fit} style={sliderStyle}
            onChange={(e) => { setFit(+e.target.value); setOption("fit", +e.target.value); }}
          />
        </label>

        <label style={labelStyle}>
          Shirt length
          <input
            type="range" min="0.8" max="1.3" step="0.01" value={length} style={sliderStyle}
            onChange={(e) => { setLength(+e.target.value); setOption("length", +e.target.value); }}
          />
        </label>

        <label style={{ ...labelStyle, fontWeight: "normal" }}>
          <input
            type="checkbox" checked={clip}
            onChange={(e) => { setClip(e.target.checked); setOption("clip", e.target.checked); }}
          />{" "}
          Shape the shirt to my body outline
        </label>

        <label style={{ ...labelStyle, fontWeight: "normal" }}>
          <input
            type="checkbox" checked={dots}
            onChange={(e) => { setDots(e.target.checked); setOption("dots", e.target.checked); }}
          />{" "}
          Show tracking dots
        </label>
      </section>

      {/* CONTROLS */}
      <div className="controls">
        <div>🫲 LEFT HAND → — NEXT TOP</div>
        <div>RIGHT HAND ← — PREVIOUS TOP 🫱</div>
        <div>🦶 RIGHT FOOT STOMP — NEXT BOTTOM</div>
        <div>🦶 LEFT FOOT STOMP — PREVIOUS BOTTOM</div>
      </div>

      {/* ADD TO CLOSET */}
      <section className="closet-upload">
        <h2>♡ ADD TO CLOSET ♡</h2>

        <p className="upload-description">
          Upload one or multiple clothing photos. We'll automatically remove their backgrounds.
          For tops, a flat photo (laid out or on a hanger) works best.
        </p>

        <div className="clothing-type-buttons">
          <button
            type="button"
            className={clothingType === "top" ? "type-button selected" : "type-button"}
            onClick={() => setClothingType("top")}
            disabled={isRemovingBackground}
          >
            👚 TOP
          </button>

          <button
            type="button"
            className={clothingType === "bottom" ? "type-button selected" : "type-button"}
            onClick={() => setClothingType("bottom")}
            disabled={isRemovingBackground}
          >
            👖 BOTTOM
          </button>
        </div>

        <div className="selected-type">
          Adding to:{" "}
          <strong>
            {clothingType === "top" ? `TOPS 👚 (${tops.length})` : `BOTTOMS 👖 (${bottoms.length})`}
          </strong>
        </div>

        <label className="upload-button">
          {isRemovingBackground ? "✨ PROCESSING CLOTHING..." : "📸 UPLOAD CLOTHING"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp"
            onChange={handleImageUpload}
            className="file-input"
            disabled={isRemovingBackground}
            multiple
          />
        </label>

        {isRemovingBackground && (
          <div style={{ marginTop: "20px", fontWeight: "bold", color: "#d6006e" }}>
            ✨ Removing backgrounds...
            <br />
            <small>Multiple images are processed one at a time.</small>
          </div>
        )}

        {closetSection({ type: "top", icon: "👚", label: "TOPS", items: tops, current: topNumber })}
        {closetSection({ type: "bottom", icon: "👖", label: "BOTTOMS", items: bottoms, current: bottomNumber })}
      </section>
    </div>
  );
}

export default App;
