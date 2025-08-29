import asyncio
import logging
import json
from typing import Type, Optional
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from tavily import TavilyClient
import requests
from assemblyai.streaming.v3 import (
    BeginEvent,
    StreamingClient,
    StreamingClientOptions,
    StreamingError,
    StreamingEvents,
    StreamingParameters,
    StreamingSessionParameters,
    TerminationEvent,
    TurnEvent,
)
import os

# ----------------------------
# Logging
# ----------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ----------------------------
# FastAPI app
# ----------------------------
app = FastAPI()

# Serve static frontend
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def serve_index():
    with open("static/index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())

# ----------------------------
# Global session variables (single-session oriented)
# ----------------------------
# NOTE: This approach stores session state in-process and is simplest for
# single-instance deployments. If you expect multiple concurrent users
# or scale horizontally, store per-session state elsewhere (Redis, DB).
aai_client: Optional[StreamingClient] = None
aai_websocket: Optional[WebSocket] = None
fastapi_loop: Optional[asyncio.AbstractEventLoop] = None

# per-session service clients / keys
gemini_client = None
tavily_client = None
MURF_API_KEY: Optional[str] = None

# ----------------------------
# Murf streaming helper
# ----------------------------
async def stream_text_to_murf(text: str):
    """Send text to Murf and forward base64 audio chunks to the WebSocket client."""
    global aai_websocket, fastapi_loop, MURF_API_KEY
    if not MURF_API_KEY:
        logger.warning("No Murf key available for this session; skipping TTS.")
        return

    import websockets  # local import so module not required until used

    MURF_WS_URL = "wss://api.murf.ai/v1/speech/stream-input"
    MURF_CONTEXT_ID = "session-context-1"

    async with websockets.connect(
        f"{MURF_WS_URL}?api_key={MURF_API_KEY}&sample_rate=44100&channel_type=MONO&format=WAV"
    ) as ws:
        # voice config
        voice_config_msg = {
            "voice_config": {
                "voiceId": "en-US-amara",
                "style": "Conversational",
                "rate": 0,
                "pitch": 0,
                "variation": 1,
            },
            "context_id": MURF_CONTEXT_ID,
        }
        await ws.send(json.dumps(voice_config_msg))

        # send text
        text_msg = {"text": text, "context_id": MURF_CONTEXT_ID, "end": True}
        await ws.send(json.dumps(text_msg))

        async def safe_send_to_client(msg: dict):
            global aai_websocket
            if not aai_websocket:
                return
            try:
                await aai_websocket.send_text(json.dumps(msg))
            except Exception as e:
                logger.warning("Tried to send to WS client after it closed: %s", e)

        try:
            while True:
                response = await ws.recv()
                data = json.loads(response)
                if "audio" in data:
                    b64_audio = data["audio"]
                    logger.info("Forwarding Murf audio chunk to client")
                    if aai_websocket and fastapi_loop:
                        message = {"type": "audio_chunk", "data": b64_audio}
                        fastapi_loop.call_soon_threadsafe(
                            asyncio.create_task, safe_send_to_client(message)
                        )

                if "final" in data and data["final"]:
                    logger.info("Received final audio chunk from Murf")
                    if aai_websocket and fastapi_loop:
                        message = {"type": "audio_end"}
                        fastapi_loop.call_soon_threadsafe(
                            asyncio.create_task, safe_send_to_client(message)
                        )
                    break

        except Exception as e:
            logger.warning("Murf connection ended or errored: %s", e)


# ----------------------------
# Gemini stream runner (runs in thread)
# ----------------------------
async def call_gemini_stream(final_transcript: str):
    """Call Gemini streaming on a background thread and forward text + stream to Murf."""
    global gemini_client, aai_websocket, fastapi_loop

    if not gemini_client:
        logger.warning("No Gemini client configured for this session.")
        return

    accumulated = []

    def _run():
        # streaming generator from genai client
        stream = gemini_client.models.generate_content_stream(
            model="gemini-2.5-flash",
            config=types.GenerateContentConfig(
                # Keep a neutral system instruction; UI or developer can edit later.
                system_instruction="You are a helpful assistant.",
                max_output_tokens=512,
            ),
            contents=final_transcript,
        )
        for response in stream:
            if response.text:
                accumulated.append(response.text)

    await asyncio.to_thread(_run)
    final_text = "".join(accumulated)
    logger.info("Final Gemini response (len=%d)", len(final_text))

    # send text to frontend
    if aai_websocket and fastapi_loop:
        msg = {"type": "gemini_response", "text": final_text}
        fastapi_loop.call_soon_threadsafe(
            asyncio.create_task, aai_websocket.send_text(json.dumps(msg))
        )

    # send to Murf for TTS (if Murf key present)
    await stream_text_to_murf(final_text)


# ----------------------------
# Tavily helper (runs in thread)
# ----------------------------
async def call_tavily(query: str):
    global tavily_client, aai_websocket, fastapi_loop
    if not tavily_client:
        logger.warning("No Tavily client configured for this session.")
        return

    def _search():
        try:
            return tavily_client.search(query)
        except Exception as e:
            logger.warning("Tavily search failed: %s", e)
            return {"results": []}

    tavily_response = await asyncio.to_thread(_search)
    results = tavily_response.get("results", [])
    if results:
        top = results[0]
        tavily_text = f"{top.get('title','No title')}: {top.get('content','No content')}"
    else:
        tavily_text = "No details found."

    if aai_websocket and fastapi_loop:
        message = {"type": "tavily_result", "text": tavily_text, "raw": tavily_response}
        fastapi_loop.call_soon_threadsafe(
            asyncio.create_task, aai_websocket.send_text(json.dumps(message))
        )


# ----------------------------
# AssemblyAI event handlers (reuse simple handlers)
# ----------------------------
def on_begin(self: Type[StreamingClient], event: BeginEvent):
    logger.info(f"Session started: {event.id}")


def on_turn(self: Type[StreamingClient], event: TurnEvent):
    # only handle finalized formatted turns
    if not event.end_of_turn or not event.turn_is_formatted:
        return

    logger.info("Final formatted transcript: %s", event.transcript)

    if aai_websocket and event.transcript and fastapi_loop:
        # send transcript to frontend
        message = {"type": "turn_end", "transcript": event.transcript}
        fastapi_loop.call_soon_threadsafe(
            asyncio.create_task, aai_websocket.send_text(json.dumps(message))
        )

        # background tasks: gemini + murf + tavily
        fastapi_loop.create_task(call_gemini_stream(event.transcript))
        fastapi_loop.create_task(call_tavily(event.transcript))


def on_terminated(self: Type[StreamingClient], event: TerminationEvent):
    logger.info("Session terminated: %s seconds audio processed", event.audio_duration_seconds)


def on_error(self: Type[StreamingClient], error: StreamingError):
    logger.error("AssemblyAI streaming error: %s", error)


# ----------------------------
# WebSocket endpoint
# ----------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Protocol:
     - Client connects and then sends *one* JSON text message:
         { "assembly": "...", "google": "...", "murf": "...", "tavily": "...", "weather": "..." }
     - After this first text message, the client will start sending raw PCM audio via binary frames.
    """
    global aai_client, aai_websocket, fastapi_loop, gemini_client, tavily_client, MURF_API_KEY

    aai_websocket = websocket
    await websocket.accept()
    fastapi_loop = asyncio.get_running_loop()

    # 1) Receive first message (JSON keys)
    try:
        raw = await websocket.receive_text()
        keys = json.loads(raw)
        assembly_key = keys.get("assembly") or keys.get("ASSEMBLYAI_API_KEY")
        google_key = keys.get("google") or keys.get("GOOGLE_API_KEY")
        murf_key = keys.get("murf") or keys.get("MURF_API_KEY")
        tavily_key = keys.get("tavily") or keys.get("TAVILY_API_KEY")
    except Exception as e:
        logger.error("Failed to receive initial keys from client: %s", e)
        await websocket.close(code=4000)
        aai_websocket = None
        return

    # store murf key for TTS helper
    MURF_API_KEY = murf_key

    # 2) Create per-session clients (Gemini, Tavily, AssemblyAI)
    try:
        if google_key:
            gemini_client = genai.Client(api_key=google_key)
        else:
            gemini_client = None

        if tavily_key:
            tavily_client = TavilyClient(api_key=tavily_key)
        else:
            tavily_client = None

        if not assembly_key:
            logger.error("AssemblyAI key missing in session startup; closing.")
            await websocket.send_text(json.dumps({"type": "error", "message": "AssemblyAI key missing"}))
            await websocket.close(code=4001)
            aai_websocket = None
            return

        # create AssemblyAI streaming client
        aai_client = StreamingClient(
            StreamingClientOptions(api_key=assembly_key, api_host="streaming.assemblyai.com")
        )
        # attach handlers
        aai_client.on(StreamingEvents.Begin, on_begin)
        aai_client.on(StreamingEvents.Turn, on_turn)
        aai_client.on(StreamingEvents.Termination, on_terminated)
        aai_client.on(StreamingEvents.Error, on_error)

        # connect with parameters (format_turns for final transcripts)
        aai_client.connect(StreamingParameters(sample_rate=16000, format_turns=True))
        logger.info("AssemblyAI client connected for session.")
    except Exception as e:
        logger.error("Failed to initialize session clients: %s", e)
        await websocket.send_text(json.dumps({"type": "error", "message": "Failed to initialize services"}))
        await websocket.close(code=4002)
        aai_websocket = None
        return

    # 3) Now accept binary PCM frames from the client and stream to AssemblyAI
    try:
        while True:
            # receive bytes (raw PCM)
            message = await websocket.receive()
            if message is None:
                break

            if "bytes" in message:
                data = message["bytes"]
                if aai_client:
                    try:
                        aai_client.stream(data)
                    except Exception as e:
                        logger.warning("Error streaming to AssemblyAI: %s", e)

            # if client closed
            if message.get("type") == "websocket.disconnect":
                break

    except Exception as e:
        logger.error("WebSocket error during streaming: %s", e)
    finally:
        logger.info("Client disconnected; cleaning up session.")
        aai_websocket = None
        try:
            if aai_client:
                aai_client.disconnect(terminate=True)
                logger.info("AssemblyAI client disconnected.")
        except Exception as e:
            logger.warning("Error during AssemblyAI disconnect: %s", e)


# ----------------------------
# Weather endpoint (accepts key param)
# ----------------------------
@app.get("/api/weather")
def get_weather(city: str = "Delhi", key: str = ""):
    if not key:
        return JSONResponse({"error": "Weather API key missing"}, status_code=400)
    url = f"http://api.weatherapi.com/v1/current.json?key={key}&q={city}&aqi=no"
    try:
        r = requests.get(url, timeout=8)
        return JSONResponse(r.json())
    except Exception as e:
        logger.error("Weather API error: %s", e)
        return JSONResponse({"error": "Weather API request failed"}, status_code=502)
