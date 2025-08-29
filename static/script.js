let ws;
let audioContext;
let processor;
let source;
let stream;

const transcriptEl = document.getElementById("transcript");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const audioStatusEl = document.getElementById("audioStatus");
const tavilyEl = document.getElementById("tavilyResponse"); // Tavily box

// Playback scheduling state
let playStartTime = 0;

// USER KEYS persisted in localStorage
let USER_KEYS = {
  assembly: "",
  google: "",
  murf: "",
  tavily: "",
  weather: ""
};

// load saved keys (if any)
function loadKeysToUI() {
  const saved = localStorage.getItem("VA2_KEYS");
  if (saved) {
    USER_KEYS = JSON.parse(saved);
    document.getElementById("assemblyKey").value = USER_KEYS.assembly || "";
    document.getElementById("googleKey").value = USER_KEYS.google || "";
    document.getElementById("murfKey").value = USER_KEYS.murf || "";
    document.getElementById("tavilyKey").value = USER_KEYS.tavily || "";
    document.getElementById("weatherKey").value = USER_KEYS.weather || "";
    document.getElementById("keyStatus").textContent = "🔑 Keys loaded from last session.";
  }
}

document.getElementById("saveKeysBtn").addEventListener("click", () => {
  USER_KEYS.assembly = document.getElementById("assemblyKey").value.trim();
  USER_KEYS.google = document.getElementById("googleKey").value.trim();
  USER_KEYS.murf = document.getElementById("murfKey").value.trim();
  USER_KEYS.tavily = document.getElementById("tavilyKey").value.trim();
  USER_KEYS.weather = document.getElementById("weatherKey").value.trim();

  localStorage.setItem("VA2_KEYS", JSON.stringify(USER_KEYS));
  document.getElementById("keyStatus").textContent = "✅ Keys saved for this session!";
});

// Base64 → Float32Array (from PCM16)
function base64ToFloat32Array(base64) {
  const binary = atob(base64);
  const len = binary.length / 2;
  const buffer = new ArrayBuffer(len * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < len; i++) {
    const val = (binary.charCodeAt(2 * i + 1) << 8) | binary.charCodeAt(2 * i);
    const signed = val >= 0x8000 ? val - 0x10000 : val;
    view.setFloat32(i * 4, signed / 0x8000, true);
  }
  return new Float32Array(buffer);
}

function playAudioChunk(b64) {
  if (!audioContext) return;
  const float32Data = base64ToFloat32Array(b64);
  const audioBuffer = audioContext.createBuffer(1, float32Data.length, 40000);
  audioBuffer.getChannelData(0).set(float32Data);

  const src = audioContext.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(audioContext.destination);

  if (playStartTime < audioContext.currentTime) {
    playStartTime = audioContext.currentTime;
  }
  src.start(playStartTime);
  playStartTime += audioBuffer.duration;

  audioStatusEl.textContent = "🔊 Playing response...";
}

startBtn.onclick = startStreaming;
stopBtn.onclick = stopStreaming;

function setTavilyWaiting() {
  tavilyEl.innerHTML = `<em>⏳ Waiting for query...</em>`;
}
function setTavilySearching() {
  tavilyEl.innerHTML = `<em>🔎 Searching…</em>`;
}

function renderTavilyResult(payload) {
  const { text, raw } = payload || {};
  let html = "";
  if (text && typeof text === "string" && text.trim().length > 0) {
    html += `<p>${escapeHtml(text)}</p>`;
  }

  const results = raw && Array.isArray(raw.results) ? raw.results.slice(0, 3) : [];
  if (results.length > 0) {
    html += `<div class="tavily-sources"><strong>Sources</strong><ul>`;
    for (const r of results) {
      const title = r.title || "Untitled";
      const url = r.url || "#";
      html += `<li><a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a></li>`;
    }
    html += `</ul></div>`;
  }

  if (!html) html = `<em>No relevant results found.</em>`;
  tavilyEl.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function escapeAttr(s) {
  return String(s).replaceAll('"', "&quot;");
}

// Start streaming: open WS, send keys JSON as first message, then start audio streaming
async function startStreaming() {
  // ensure keys exist
  if (!USER_KEYS.assembly) {
    alert("Please set and save your AssemblyAI API key in the API Keys Setup box.");
    return;
  }

  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsScheme}://${location.host}/ws`;
  ws = new WebSocket(wsUrl);

  ws.binaryType = "arraybuffer";

  ws.onopen = async () => {
    transcriptEl.innerHTML = "<p>🔴 Streaming started...</p>";
    setTavilyWaiting();

    // Send keys as first message (JSON text)
    ws.send(JSON.stringify(USER_KEYS));

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "turn_end") {
          const p = document.createElement("p");
          p.textContent = msg.transcript;
          transcriptEl.appendChild(p);
          transcriptEl.scrollTop = transcriptEl.scrollHeight;

          setTavilySearching();

          // keep Gemini on client as optional background (still uses USER_KEYS.google)
          callGeminiStream(msg.transcript);
        }

        if (msg.type === "tavily_result") {
          renderTavilyResult({ text: msg.text, raw: msg.raw });
        }

        if (msg.type === "audio_chunk") {
          playAudioChunk(msg.data);
        }

        if (msg.type === "audio_end") {
          audioStatusEl.textContent = "✔️ Playback finished.";
        }

        if (msg.type === "gemini_response") {
          const p = document.createElement("p");
          p.textContent = "(Gemini) " + msg.text;
          transcriptEl.appendChild(p);
        }

        if (msg.type === "error") {
          console.error("Server error:", msg.message);
        }
      } catch (err) {
        console.error("Error parsing message:", err);
      }
    };

    // Init AudioContext lazily on user gesture
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
      });
    }

    // Get mic audio
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert("Microphone access is required.");
      return;
    }

    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7fff;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(pcm16.buffer); // send raw PCM binary
      }
    };

    startBtn.disabled = true;
    stopBtn.disabled = false;
  };

  ws.onclose = () => {
    console.log("WS closed");
  };

  ws.onerror = (e) => {
    console.error("WS error", e);
  };
}

function stopStreaming() {
  if (processor) {
    processor.disconnect();
    source.disconnect();
  }
  if (audioContext) {
    audioContext.close();
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }

  const p = document.createElement("p");
  p.textContent = "🟢 Streaming stopped.";
  transcriptEl.appendChild(p);

  audioStatusEl.textContent = "⏹️ No audio playing";
  setTavilyWaiting();

  startBtn.disabled = false;
  stopBtn.disabled = true;
}

// Client-side Gemini stream (optional, uses user's Google key)
async function callGeminiStream(finalTranscript) {
  const apiKey = USER_KEYS.google;
  if (!apiKey) return;

  const model = "models/gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:streamGenerateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: finalTranscript }],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 512,
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      console.warn("Gemini API request failed:", response.status, response.statusText);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((line) => line.trim() !== "");
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const dataStr = line.slice("data:".length).trim();
        if (dataStr === "[DONE]") continue;
        try {
          const data = JSON.parse(dataStr);
          const candidates = data.candidates || [];
          for (const c of candidates) {
            const parts = c.content?.parts || [];
            for (const p of parts) {
              if (p.text) {
                accumulated += p.text;
              }
            }
          }
        } catch (err) {
          // ignore malformed chunks
        }
      }
    }

    console.log("Gemini final:", accumulated);
    return accumulated;
  } catch (err) {
    console.warn("Gemini streaming error:", err);
  }
}

// Weather widget calls backend with user-provided weather key
async function getWeather(city = "Delhi") {
  try {
    const key = USER_KEYS.weather;
    if (!key) {
      document.getElementById("cityName").textContent = "No weather key";
      return;
    }
    const res = await fetch(`/api/weather?city=${encodeURIComponent(city)}&key=${encodeURIComponent(key)}`);
    if (!res.ok) throw new Error("Weather API error");
    const data = await res.json();

    if (data && data.location) {
      document.getElementById("cityName").textContent = data.location.name + ", " + data.location.country;
      document.getElementById("weatherIcon").src = "https:" + data.current.condition.icon;
      document.getElementById("temperature").textContent = data.current.temp_c + "°C";
      document.getElementById("condition").textContent = data.current.condition.text;
    } else {
      document.getElementById("cityName").textContent = "Not found";
    }
  } catch (err) {
    console.error("Weather widget error:", err.message);
    document.getElementById("cityName").textContent = "Not found";
    document.getElementById("weatherIcon").src = "";
    document.getElementById("temperature").textContent = "";
    document.getElementById("condition").textContent = "";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadKeysToUI();

  // default weather (if key present)
  if (USER_KEYS.weather) getWeather("New Delhi");

  document.getElementById("searchBtn").addEventListener("click", () => {
    const city = document.getElementById("cityInput").value.trim();
    if (city) getWeather(city);
  });

  document.getElementById("cityInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      const city = e.target.value.trim();
      if (city) getWeather(city);
    }
  });
});
