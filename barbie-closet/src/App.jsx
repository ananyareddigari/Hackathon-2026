import { useEffect, useRef, useState } from "react";
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import "./App.css";

function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const poseLandmarkerRef = useRef(null);
  const animationRef = useRef(null);

  // HAND HISTORY
  const leftHandHistoryRef = useRef([]);
  const rightHandHistoryRef = useRef([]);

  // FOOT HISTORY
  const leftFootHistoryRef = useRef([]);
  const rightFootHistoryRef = useRef([]);

  // Keeps track of whether a foot was lifted
  const leftFootLiftedRef = useRef(false);
  const rightFootLiftedRef = useRef(false);

  // Position where the foot normally rests
  const leftFootRestYRef = useRef(null);
  const rightFootRestYRef = useRef(null);

  const lastGestureTimeRef = useRef(0);

  const [status, setStatus] = useState(
    "Loading body tracking..."
  );

  const [gesture, setGesture] = useState(
    "Waiting for gesture..."
  );

  const [topNumber, setTopNumber] =
    useState(0);

  const [bottomNumber, setBottomNumber] =
    useState(0);

  useEffect(() => {
    let stream;

    // ==========================================
    // START CAMERA
    // ==========================================

    async function startCamera() {
      try {
        stream =
          await navigator.mediaDevices.getUserMedia({
            video: {
              width: 1280,
              height: 720,
            },

            audio: false,
          });

        const video =
          videoRef.current;

        if (!video) return;

        video.srcObject = stream;

        await new Promise((resolve) => {
          video.onloadeddata = resolve;
        });

        await video.play();

        // ======================================
        // LOAD MEDIAPIPE
        // ======================================

        const vision =
          await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
          );

        const poseLandmarker =
          await PoseLandmarker.createFromOptions(
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

        poseLandmarkerRef.current =
          poseLandmarker;

        setStatus(
          "Body + foot tracking active ✓"
        );

        detectPose();
      } catch (error) {
        console.error(error);

        setStatus(
          "Could not start body tracking"
        );
      }
    }

    // ==========================================
    // SAVE HAND POSITION
    // ==========================================

    function saveHandPosition(
      historyRef,
      wrist,
      time
    ) {
      if (
        !wrist ||
        wrist.visibility < 0.5
      ) {
        historyRef.current = [];
        return;
      }

      historyRef.current.push({
        x: wrist.x,
        y: wrist.y,
        time: time,
      });

      while (
        historyRef.current.length > 0 &&
        time -
          historyRef.current[0].time >
          450
      ) {
        historyRef.current.shift();
      }
    }

    // ==========================================
    // CHECK TOP GESTURES
    // ==========================================

    function checkTopGestures(time) {
      if (
        time -
          lastGestureTimeRef.current <
        900
      ) {
        return;
      }

      const leftHistory =
        leftHandHistoryRef.current;

      const rightHistory =
        rightHandHistoryRef.current;

      // ======================================
      // LEFT HAND →
      // NEXT TOP
      // ======================================

      if (leftHistory.length >= 4) {
        const start =
          leftHistory[0];

        const end =
          leftHistory[
            leftHistory.length - 1
          ];

        const xMovement =
          end.x - start.x;

        const yMovement =
          end.y - start.y;

        if (
          xMovement > 0.12 &&
          Math.abs(xMovement) >
            Math.abs(yMovement) * 1.3
        ) {
          setTopNumber(
            (current) => current + 1
          );

          setGesture(
            "LEFT HAND → NEXT TOP 👚"
          );

          lastGestureTimeRef.current =
            time;

          leftHandHistoryRef.current = [];
          rightHandHistoryRef.current = [];

          return;
        }
      }

      // ======================================
      // RIGHT HAND ←
      // PREVIOUS TOP
      // ======================================

      if (rightHistory.length >= 4) {
        const start =
          rightHistory[0];

        const end =
          rightHistory[
            rightHistory.length - 1
          ];

        const xMovement =
          end.x - start.x;

        const yMovement =
          end.y - start.y;

        if (
          xMovement < -0.12 &&
          Math.abs(xMovement) >
            Math.abs(yMovement) * 1.3
        ) {
          setTopNumber((current) => {
            if (current === 0) {
              setGesture(
                "🚫 FIRST TOP"
              );

              return 0;
            }

            setGesture(
              "RIGHT HAND ← PREVIOUS TOP 👚"
            );

            return current - 1;
          });

          lastGestureTimeRef.current =
            time;

          leftHandHistoryRef.current = [];
          rightHandHistoryRef.current = [];

          return;
        }
      }
    }

    // ==========================================
    // UPDATE FOOT RESTING POSITION
    // ==========================================

    function updateFootRestPosition(
      foot,
      restRef,
      liftedRef
    ) {
      if (
        !foot ||
        foot.visibility < 0.5
      ) {
        return;
      }

      // First detected position becomes
      // our starting resting position
      if (restRef.current === null) {
        restRef.current = foot.y;
        return;
      }

      /*
        Only slowly update resting position
        while the foot is NOT lifted.

        This lets the tracker adjust if you
        move slightly around the room.
      */

      if (!liftedRef.current) {
        restRef.current =
          restRef.current * 0.97 +
          foot.y * 0.03;
      }
    }

    // ==========================================
    // CHECK FOOT STOMPS
    // ==========================================

    function checkFootStomps(
      landmarks,
      time
    ) {
      /*
        MediaPipe:

        27 = left ankle
        28 = right ankle
        31 = left foot index
        32 = right foot index

        We'll use the ankle because it tends
        to be more stable than the toe.
      */

      const leftFoot =
        landmarks[27];

      const rightFoot =
        landmarks[28];

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

      // ======================================
      // RIGHT FOOT LIFTED
      // ======================================

      if (
        rightFoot.y <
        rightFootRestYRef.current -
          RIGHT_LIFT_AMOUNT
      ) {
        rightFootLiftedRef.current =
          true;
      }

      // ======================================
      // RIGHT FOOT COMES BACK DOWN
      // NEXT BOTTOM
      // ======================================

      if (
        rightFootLiftedRef.current &&
        rightFoot.y >
          rightFootRestYRef.current -
            RETURN_AMOUNT
      ) {
        if (
          time -
            lastGestureTimeRef.current >
          900
        ) {
          setBottomNumber(
            (current) => current + 1
          );

          setGesture(
            "RIGHT FOOT 🦶 — NEXT BOTTOM 👖"
          );

          lastGestureTimeRef.current =
            time;
        }

        rightFootLiftedRef.current =
          false;

        rightFootRestYRef.current =
          rightFoot.y;

        return;
      }

      // ======================================
      // LEFT FOOT LIFTED
      // ======================================

      if (
        leftFoot.y <
        leftFootRestYRef.current -
          LEFT_LIFT_AMOUNT
      ) {
        leftFootLiftedRef.current =
          true;
      }

      // ======================================
      // LEFT FOOT COMES BACK DOWN
      // PREVIOUS BOTTOM
      // ======================================

      if (
        leftFootLiftedRef.current &&
        leftFoot.y >
          leftFootRestYRef.current -
            RETURN_AMOUNT
      ) {
        if (
          time -
            lastGestureTimeRef.current >
          900
        ) {
          setBottomNumber(
            (current) => {
              if (current === 0) {
                setGesture(
                  "🚫 FIRST BOTTOM"
                );

                return 0;
              }

              setGesture(
                "LEFT FOOT 🦶 — PREVIOUS BOTTOM 👖"
              );

              return current - 1;
            }
          );

          lastGestureTimeRef.current =
            time;
        }

        leftFootLiftedRef.current =
          false;

        leftFootRestYRef.current =
          leftFoot.y;

        return;
      }
    }

    // ==========================================
    // BODY TRACKING LOOP
    // ==========================================

    function detectPose() {
      const video =
        videoRef.current;

      const canvas =
        canvasRef.current;

      const pose =
        poseLandmarkerRef.current;

      if (
        !video ||
        !canvas ||
        !pose
      ) {
        return;
      }

      const ctx =
        canvas.getContext("2d");

      if (video.readyState >= 2) {
        canvas.width =
          video.videoWidth;

        canvas.height =
          video.videoHeight;

        const time =
          performance.now();

        const result =
          pose.detectForVideo(
            video,
            time
          );

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
          const landmarks =
            result.landmarks[0];

          // ====================================
          // HAND TRACKING
          // ====================================

          const leftWrist =
            landmarks[15];

          const rightWrist =
            landmarks[16];

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

          // ====================================
          // CHECK GESTURES
          // ====================================

          checkFootStomps(
            landmarks,
            time
          );

          checkTopGestures(time);

          // ====================================
          // DRAW TRACKING DOTS
          // ====================================

          const pointsToDraw = [
            11, // left shoulder
            12, // right shoulder

            13, // left elbow
            14, // right elbow

            15, // left wrist
            16, // right wrist

            23, // left hip
            24, // right hip

            25, // left knee
            26, // right knee

            27, // left ankle
            28, // right ankle
          ];

          ctx.fillStyle =
            "#ff1493";

          ctx.strokeStyle =
            "white";

          ctx.lineWidth = 4;

          pointsToDraw.forEach(
            (index) => {
              const point =
                landmarks[index];

              if (!point) return;

              const x =
                point.x *
                canvas.width;

              const y =
                point.y *
                canvas.height;

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
            }
          );
        }
      }

      animationRef.current =
        requestAnimationFrame(
          detectPose
        );
    }

    startCamera();

    // ==========================================
    // CLEANUP
    // ==========================================

    return () => {
      cancelAnimationFrame(
        animationRef.current
      );

      if (stream) {
        stream
          .getTracks()
          .forEach((track) => {
            track.stop();
          });
      }

      if (
        poseLandmarkerRef.current
      ) {
        poseLandmarkerRef.current.close();
      }
    };
  }, []);

  // ==========================================
  // PAGE
  // ==========================================

  return (
    <div className="app">

      <header>
        <h1>
          ♡ MOTION CLOSET ♡
        </h1>

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
      <div className="closet-upload">
        <h2>♡ ADD TO CLOSET ♡</h2>

        <p>Add a clothing photo to your virtual closet</p>

        <div className="clothing-type-buttons">
          <button>👚 TOP</button>
          <button>👖 BOTTOM</button>
        </div>

        <label className="upload-button">
          📸 UPLOAD CLOTHING

          <input
            type="file"
            accept="image/*"
            hidden
          />
        </label>
      </div>

    </div>
  );
}

export default App;