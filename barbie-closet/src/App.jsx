import { useEffect, useRef, useState } from "react";
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { removeBackground } from "@imgly/background-removal";
import "./App.css";

function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const poseLandmarkerRef = useRef(null);
  const animationRef = useRef(null);

  // Hand movement history
  const leftHandHistoryRef = useRef([]);
  const rightHandHistoryRef = useRef([]);

  // Foot tracking
  const leftFootLiftedRef = useRef(false);
  const rightFootLiftedRef = useRef(false);

  const leftFootRestYRef = useRef(null);
  const rightFootRestYRef = useRef(null);

  // Gesture cooldown
  const lastGestureTimeRef = useRef(0);

  // Website state
  const [status, setStatus] = useState("Loading body tracking...");
  const [gesture, setGesture] = useState("Waiting for gesture...");

  const [topNumber, setTopNumber] = useState(0);
  const [bottomNumber, setBottomNumber] = useState(0);

  // Clothing upload state
  const [clothingType, setClothingType] = useState("top");
  const [uploadedImage, setUploadedImage] = useState(null);
  const [isRemovingBackground, setIsRemovingBackground] = useState(false);

  // =====================================================
  // CAMERA + MEDIAPIPE
  // =====================================================

  useEffect(() => {
    let stream;
    let stopped = false;

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: 1280,
            height: 720,
          },
          audio: false,
        });

        const video = videoRef.current;

        if (!video) return;

        video.srcObject = stream;

        await new Promise((resolve) => {
          video.onloadeddata = resolve;
        });

        await video.play();

        // Load MediaPipe
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );

        const poseLandmarker = await PoseLandmarker.createFromOptions(
          vision,
          {
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
          }
        );

        if (stopped) {
          poseLandmarker.close();
          return;
        }

        poseLandmarkerRef.current = poseLandmarker;

        setStatus("Body + foot tracking active ✓");

        detectPose();
      } catch (error) {
        console.error(error);
        setStatus("Could not start body tracking");
      }
    }

    // =====================================================
    // SAVE HAND POSITION
    // =====================================================

    function saveHandPosition(historyRef, wrist, time) {
      if (!wrist || wrist.visibility < 0.5) {
        historyRef.current = [];
        return;
      }

      historyRef.current.push({
        x: wrist.x,
        y: wrist.y,
        time,
      });

      // Only keep last 450ms
      while (
        historyRef.current.length > 0 &&
        time - historyRef.current[0].time > 450
      ) {
        historyRef.current.shift();
      }
    }

    // =====================================================
    // TOP GESTURES
    // =====================================================

    function checkTopGestures(time) {
      if (time - lastGestureTimeRef.current < 900) {
        return;
      }

      const leftHistory = leftHandHistoryRef.current;
      const rightHistory = rightHandHistoryRef.current;

      // LEFT HAND → NEXT TOP
      if (leftHistory.length >= 4) {
        const start = leftHistory[0];
        const end = leftHistory[leftHistory.length - 1];

        const xMovement = end.x - start.x;
        const yMovement = end.y - start.y;

        if (
          xMovement > 0.12 &&
          Math.abs(xMovement) > Math.abs(yMovement) * 1.3
        ) {
          setTopNumber((current) => current + 1);

          setGesture("🫲 LEFT HAND → NEXT TOP 👚");

          lastGestureTimeRef.current = time;

          leftHandHistoryRef.current = [];
          rightHandHistoryRef.current = [];

          return;
        }
      }

      // RIGHT HAND ← PREVIOUS TOP
      if (rightHistory.length >= 4) {
        const start = rightHistory[0];
        const end = rightHistory[rightHistory.length - 1];

        const xMovement = end.x - start.x;
        const yMovement = end.y - start.y;

        if (
          xMovement < -0.12 &&
          Math.abs(xMovement) > Math.abs(yMovement) * 1.3
        ) {
          setTopNumber((current) => {
            if (current === 0) {
              setGesture("🚫 FIRST TOP");
              return 0;
            }

            setGesture("RIGHT HAND ← PREVIOUS TOP 👚");

            return current - 1;
          });

          lastGestureTimeRef.current = time;

          leftHandHistoryRef.current = [];
          rightHandHistoryRef.current = [];

          return;
        }
      }
    }

    // =====================================================
    // FOOT RESTING POSITION
    // =====================================================

    function updateFootRestPosition(foot, restRef, liftedRef) {
      if (!foot || foot.visibility < 0.5) {
        return;
      }

      if (restRef.current === null) {
        restRef.current = foot.y;
        return;
      }

      if (!liftedRef.current) {
        restRef.current =
          restRef.current * 0.97 +
          foot.y * 0.03;
      }
    }

    // =====================================================
    // FOOT STOMP GESTURES
    // =====================================================

    function checkFootStomps(landmarks, time) {
      // 27 = left ankle
      // 28 = right ankle

      const leftFoot = landmarks[27];
      const rightFoot = landmarks[28];

      if (
        !leftFoot ||
        !rightFoot ||
        leftFoot.visibility < 0.5 ||
        rightFoot.visibility < 0.5
      ) {
        return;
      }

      updateFootRestPosition(
        leftFoot,
        leftFootRestYRef,
        leftFootLiftedRef
      );

      updateFootRestPosition(
        rightFoot,
        rightFootRestYRef,
        rightFootLiftedRef
      );

      if (
        leftFootRestYRef.current === null ||
        rightFootRestYRef.current === null
      ) {
        return;
      }

      const LEFT_LIFT_AMOUNT = 0.055;
      const RIGHT_LIFT_AMOUNT = 0.055;
      const RETURN_AMOUNT = 0.025;

      // RIGHT FOOT LIFT
      if (
        rightFoot.y <
        rightFootRestYRef.current - RIGHT_LIFT_AMOUNT
      ) {
        rightFootLiftedRef.current = true;
      }

      // RIGHT FOOT RETURNS = NEXT BOTTOM
      if (
        rightFootLiftedRef.current &&
        rightFoot.y >
          rightFootRestYRef.current - RETURN_AMOUNT
      ) {
        if (time - lastGestureTimeRef.current > 900) {
          setBottomNumber((current) => current + 1);

          setGesture(
            "🦶 RIGHT FOOT STOMP — NEXT BOTTOM 👖"
          );

          lastGestureTimeRef.current = time;
        }

        rightFootLiftedRef.current = false;
        rightFootRestYRef.current = rightFoot.y;

        return;
      }

      // LEFT FOOT LIFT
      if (
        leftFoot.y <
        leftFootRestYRef.current - LEFT_LIFT_AMOUNT
      ) {
        leftFootLiftedRef.current = true;
      }

      // LEFT FOOT RETURNS = PREVIOUS BOTTOM
      if (
        leftFootLiftedRef.current &&
        leftFoot.y >
          leftFootRestYRef.current - RETURN_AMOUNT
      ) {
        if (time - lastGestureTimeRef.current > 900) {
          setBottomNumber((current) => {
            if (current === 0) {
              setGesture("🚫 FIRST BOTTOM");
              return 0;
            }

            setGesture(
              "🦶 LEFT FOOT STOMP — PREVIOUS BOTTOM 👖"
            );

            return current - 1;
          });

          lastGestureTimeRef.current = time;
        }

        leftFootLiftedRef.current = false;
        leftFootRestYRef.current = leftFoot.y;

        return;
      }
    }

    // =====================================================
    // POSE DETECTION LOOP
    // =====================================================

    function detectPose() {
      if (stopped) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      const pose = poseLandmarkerRef.current;

      if (!video || !canvas || !pose) {
        return;
      }

      const ctx = canvas.getContext("2d");

      if (video.readyState >= 2) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const time = performance.now();

        const result = pose.detectForVideo(video, time);

        ctx.clearRect(
          0,
          0,
          canvas.width,
          canvas.height
        );

        if (
          result.landmarks &&
          result.landmarks.length > 0
        ) {
          const landmarks = result.landmarks[0];

          // HANDS
          const leftWrist = landmarks[15];
          const rightWrist = landmarks[16];

          saveHandPosition(
            leftHandHistoryRef,
            leftWrist,
            time
          );

          saveHandPosition(
            rightHandHistoryRef,
            rightWrist,
            time
          );

          // CHECK GESTURES
          checkFootStomps(landmarks, time);
          checkTopGestures(time);

          // DRAW TRACKING DOTS
          const pointsToDraw = [
            11,
            12,
            13,
            14,
            15,
            16,
            23,
            24,
            25,
            26,
            27,
            28,
          ];

          ctx.fillStyle = "#ff1493";
          ctx.strokeStyle = "white";
          ctx.lineWidth = 4;

          pointsToDraw.forEach((index) => {
            const point = landmarks[index];

            if (!point) return;

            const x = point.x * canvas.width;
            const y = point.y * canvas.height;

            ctx.beginPath();

            ctx.arc(
              x,
              y,
              9,
              0,
              Math.PI * 2
            );

            ctx.fill();
            ctx.stroke();
          });
        }
      }

      animationRef.current =
        requestAnimationFrame(detectPose);
    }

    startCamera();

    // CLEANUP
    return () => {
      stopped = true;

      if (animationRef.current) {
        cancelAnimationFrame(
          animationRef.current
        );
      }

      if (stream) {
        stream
          .getTracks()
          .forEach((track) => track.stop());
      }

      if (poseLandmarkerRef.current) {
        poseLandmarkerRef.current.close();
        poseLandmarkerRef.current = null;
      }
    };
  }, []);

  // =====================================================
  // UPLOAD + AUTOMATIC BACKGROUND REMOVAL
  // =====================================================

  async function handleImageUpload(event) {
    const file = event.target.files?.[0];

    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setGesture("❌ PLEASE CHOOSE AN IMAGE");
      return;
    }

    setIsRemovingBackground(true);
    setGesture("✨ REMOVING BACKGROUND...");

    try {
      /*
        IMG.LY processes the image in the browser
        and returns a PNG Blob with transparency.
      */
      const transparentBlob =
        await removeBackground(file, {
          output: {
            format: "image/png",
            quality: 1,
            type: "foreground",
          },
        });

      const transparentURL =
        URL.createObjectURL(transparentBlob);

      setUploadedImage((oldImage) => {
        if (oldImage) {
          URL.revokeObjectURL(oldImage);
        }

        return transparentURL;
      });

      setGesture(
        `✨ ${clothingType.toUpperCase()} READY — BACKGROUND REMOVED`
      );
    } catch (error) {
      console.error(
        "Background removal error:",
        error
      );

      setGesture(
        "❌ BACKGROUND REMOVAL FAILED — TRY ANOTHER IMAGE"
      );
    } finally {
      setIsRemovingBackground(false);

      // Allows same image to be selected again
      event.target.value = "";
    }
  }

  // =====================================================
  // REMOVE UPLOADED IMAGE
  // =====================================================

  function removeUploadedImage() {
    if (uploadedImage) {
      URL.revokeObjectURL(uploadedImage);
    }

    setUploadedImage(null);
    setGesture("Clothing removed");
  }

  // =====================================================
  // PAGE
  // =====================================================

  return (
    <div className="app">

      <header className="main-header">
        <h1>♡ MOTION CLOSET ♡</h1>

        <p>
          Your body. Your closet. Your style.
        </p>
      </header>

      <div className="status">
        {status}
      </div>

      <div className="gesture-display">
        {gesture}
      </div>

      <div className="top-display">
        👚 CURRENT TOP: {topNumber}
      </div>

      <div className="bottom-display">
        👖 CURRENT BOTTOM: {bottomNumber}
      </div>

      {/* CAMERA */}

      <div className="camera-frame">

        <div className="camera-container">

          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="camera"
          />

          <canvas
            ref={canvasRef}
            className="pose-canvas"
          />

        </div>

        <div className="camera-label">
          ✦ LIVE FITTING ROOM ✦
        </div>

      </div>

      {/* GESTURE CONTROLS */}

      <div className="controls">

        <div>
          🫲 LEFT HAND → — NEXT TOP
        </div>

        <div>
          RIGHT HAND ← — PREVIOUS TOP 🫱
        </div>

        <div>
          🦶 RIGHT FOOT STOMP — NEXT BOTTOM
        </div>

        <div>
          🦶 LEFT FOOT STOMP — PREVIOUS BOTTOM
        </div>

      </div>

      {/* ADD TO CLOSET */}

      <section className="closet-upload">

        <h2>♡ ADD TO CLOSET ♡</h2>

        <p className="upload-description">
          Upload a clothing photo and we'll
          automatically remove the background
        </p>

        <div className="clothing-type-buttons">

          <button
            type="button"
            className={
              clothingType === "top"
                ? "type-button selected"
                : "type-button"
            }
            onClick={() =>
              setClothingType("top")
            }
            disabled={isRemovingBackground}
          >
            👚 TOP
          </button>

          <button
            type="button"
            className={
              clothingType === "bottom"
                ? "type-button selected"
                : "type-button"
            }
            onClick={() =>
              setClothingType("bottom")
            }
            disabled={isRemovingBackground}
          >
            👖 BOTTOM
          </button>

        </div>

        <div className="selected-type">
          Adding to:{" "}
          <strong>
            {clothingType === "top"
              ? "TOPS 👚"
              : "BOTTOMS 👖"}
          </strong>
        </div>

        <label className="upload-button">

          {isRemovingBackground
            ? "✨ REMOVING BACKGROUND..."
            : "📸 UPLOAD CLOTHING"}

          <input
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp"
            onChange={handleImageUpload}
            className="file-input"
            disabled={isRemovingBackground}
          />

        </label>

        {isRemovingBackground && (
          <div
            style={{
              marginTop: "20px",
              fontWeight: "bold",
              color: "#d6006e",
            }}
          >
            ✨ AI is cutting out your clothing...
            <br />
            <small>
              The first image may take a little longer.
            </small>
          </div>
        )}

        {/* TRANSPARENT IMAGE PREVIEW */}

        {uploadedImage &&
          !isRemovingBackground && (

          <div className="upload-preview">

            <div className="preview-title">
              ✨ BACKGROUND REMOVED ✨
            </div>

            <div className="preview-image-container">

              <img
                src={uploadedImage}
                alt={`Uploaded ${clothingType}`}
                className="preview-image"
              />

            </div>

            <div className="preview-type">
              {clothingType === "top"
                ? "👚 TOP"
                : "👖 BOTTOM"}
            </div>

            <button
              type="button"
              className="remove-image-button"
              onClick={removeUploadedImage}
            >
              REMOVE IMAGE
            </button>

          </div>
        )}

      </section>

    </div>
  );
}

export default App;