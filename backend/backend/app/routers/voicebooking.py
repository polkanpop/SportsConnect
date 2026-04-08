"""
Voice Booking — Groq-powered speech-to-booking-intent endpoint.

Two paths:
  A) Text path (primary — uses on-device speech recognition via expo-speech-recognition):
     POST /api/speech/parse-intent  { "transcript": "..." }
     → Groq LLM parses Vietnamese/English/mixed text into structured booking intent.

  B) Audio path (future — when expo-audio is installed):
     POST /api/speech/booking-intent  (multipart audio file)
     → Groq Whisper transcribes → Groq LLM parses intent.

Environment variables required on Render:
  GROQ_API_KEY — Groq Cloud API key
"""

import json
import logging
import os
import tempfile
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

logger = logging.getLogger("voicebooking")

router = APIRouter(prefix="/speech", tags=["voice-booking"])

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
WHISPER_MODEL = "whisper-large-v3-turbo"
LLM_MODEL = "llama-3.1-8b-instant"
MAX_AUDIO_SIZE = 10 * 1024 * 1024  # 10 MB

# ── Response models ────────────────────────────────────────────────────────────

class ExtractedFields(BaseModel):
    court_name_raw: Optional[str] = None
    court_half: Optional[bool] = None
    date_raw: Optional[str] = None
    time_start_raw: Optional[str] = None
    duration_raw: Optional[str] = None
    player_count: Optional[int] = None
    event_name_raw: Optional[str] = None
    event_id_raw: Optional[str] = None
    booking_ref_raw: Optional[str] = None
    cancel_type: Optional[str] = None


class VoiceBookingResponse(BaseModel):
    transcript: str
    intent: Optional[str] = None  # book_court | book_training_session | book_event | cancel_booking | check_availability | query_schedule | greeting | off_topic | unclear
    booking_type: Optional[str] = None  # court | training_session | event | null
    confidence: float = 0.0
    noise_signal: bool = False
    noise_reason: Optional[str] = None  # multi_speaker | unintelligible | background_only | off_topic
    language_detected: Optional[str] = None  # vi | en | vi_en_mix
    extracted: Optional[ExtractedFields] = None
    clarification_needed: List[str] = []
    # UX routing fields (computed by backend after Groq response)
    reply_type: Optional[str] = None  # noise | greeting | off_topic | unclear | clarification | optimistic | error
    reply_message: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None


class ParseIntentRequest(BaseModel):
    transcript: str = Field(..., min_length=1, max_length=2000)


# Legacy model kept for audio path compatibility
class LegacyBookingIntent(BaseModel):
    date: Optional[str] = None
    time: Optional[str] = None
    duration_minutes: Optional[int] = None
    court_type: Optional[str] = None
    payment_method: Optional[str] = None
    note: Optional[str] = None


# ── Helpers ────────────────────────────────────────────────────────────────────

ALLOWED_CONTENT_TYPES = {
    "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/mpeg",
    "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg",
    "audio/flac", "video/mp4",  # some Android recorders tag m4a as video/mp4
    "application/octet-stream",  # fallback when MIME detection fails
}

INTENT_SYSTEM_PROMPT = """\
You are the voice understanding engine for **SportConnect**, a Vietnamese sports court booking application.

Your name inside this system is **SCOUT** (SportConnect's Understanding and Translation module).

You work inside a push-to-talk voice booking flow. A user holds down a mic button on their phone, speaks their request in Vietnamese, English, or a mix of both, releases the button, and their speech gets transcribed by Whisper before reaching you.

Your job — and your **only** job — is to listen to what the user said and extract the raw pieces of information from their words into a clean, structured JSON object. You are a reader and a parser. You are not a validator. You are not a decision-maker. You do not know what courts exist. You do not know what times are available. You do not know if a date is in the past. You do not know if a training session has seats left. All of that is someone else's job. Your job ends the moment you have packaged what the user said into JSON.

**Read. Extract. Package. Return. That is all.**

SportConnect has three booking flows:

1. Court Booking (book_court) — user wants to reserve a physical court. Key signals: "sân", court name/number, specific date+time. Required: court_name_raw, date_raw, time_start_raw. Optional: duration_raw, player_count, court_half.

2. Training Session Booking (book_training_session) — user wants to join a coach-led session. Key signals: "tập", "buổi tập", "training", "lớp", "coach", "huấn luyện". Required: at least one of (date_raw + time_start_raw) OR event_name_raw.

3. Event Booking (book_event) — user wants to register for an event/tournament. Key signals: "sự kiện", "giải", "giải đấu", "tournament", "event", "tham gia". Required: at least one of (event_name_raw OR event_id_raw OR date_raw).

Return a single raw JSON object. Nothing before it. Nothing after it. No markdown. No explanation.

Schema:
{
  "intent": "book_court | book_training_session | book_event | cancel_booking | check_availability | query_schedule | greeting | off_topic | unclear",
  "booking_type": "court | training_session | event | null",
  "confidence": 0.0,
  "noise_signal": false,
  "noise_reason": null,
  "language_detected": "vi | en | vi_en_mix",
  "extracted": {
    "court_name_raw": null,
    "court_half": null,
    "date_raw": null,
    "time_start_raw": null,
    "duration_raw": null,
    "player_count": null,
    "event_name_raw": null,
    "event_id_raw": null,
    "booking_ref_raw": null,
    "cancel_type": null
  },
  "clarification_needed": []
}

Field rules:
- intent: exactly one of the values above. "greeting" for hello/hi/xin chào. "off_topic" for non-sports content. "unclear" when confidence < 0.50.
- booking_type: "court" for book_court, "training_session" for book_training_session, "event" for book_event, null for everything else.
- confidence: 0.0-1.0. 1.0 = perfectly clear. 0.90-0.99 = clear with minor gaps. 0.70-0.89 = clear intent but fields missing. 0.50-0.69 = roughly understood. Below 0.50 = cannot determine.
- noise_signal: true if confidence < 0.70, multiple speakers, unintelligible, background only, or off-topic. false for normal requests even with missing fields.
- noise_reason: "multi_speaker" | "unintelligible" | "background_only" | "off_topic" | null.
- language_detected: "vi" (Vietnamese), "en" (English), "vi_en_mix" (mixed — very common, not an error).
- All extracted fields: extract EXACTLY what the user said, raw, untranslated. null if not mentioned.
- court_half: true ONLY if user explicitly said "half court"/"nửa sân"/"nua san"/"half san". null otherwise. Never false.
- clarification_needed: list of required field names that were NOT mentioned. Missing fields are NOT noise.
- cancel_type: "court" | "training_session" | "event" | null (only when intent is cancel_booking).

Required fields by intent:
- book_court: court_name_raw, date_raw, time_start_raw
- book_training_session: at least one of date_raw or event_name_raw
- book_event: at least one of event_name_raw, event_id_raw, date_raw
- cancel_booking: cancel_type (and ideally booking_ref_raw)
- check_availability: court_name_raw or date_raw

Viet-English mixing is normal. Do not penalise confidence for it. "tôi muốn book sân 3 this saturday 7pm" is a perfectly valid request.

Reminders:
1. Return JSON only. No text before or after.
2. Never invent values. null when not said.
3. Never validate — extraction only.
4. Never translate extracted values.
5. Missing fields go in clarification_needed, NOT noise.
6. court_half only true when explicitly said.
"""


# ── UX Reply Scripts ───────────────────────────────────────────────────────────

REPLY_NOISE_MULTI = "Có vẻ có nhiều tiếng ồn xung quanh. Bạn hãy đưa micro gần miệng hơn và thử lại nhé!"
REPLY_NOISE_UNINTELLIGIBLE = "Mình chưa nghe rõ lắm. Bạn hãy thử lại — đưa micro gần và nói rõ hơn nhé."
REPLY_OFF_TOPIC = "Mình có thể giúp bạn đặt sân, tham gia buổi tập, hoặc đăng ký sự kiện. Bạn muốn làm gì?"
REPLY_GREETING = "Chào bạn! Hãy giữ nút micro và cho mình biết bạn muốn đặt sân nào, hoặc hỏi về sự kiện sắp tới nhé."
REPLY_UNCLEAR = "Mình chưa hiểu rõ lắm. Bạn thử lại nhé? Ví dụ: 'đặt sân 3 thứ 7 7 giờ tối'."

CLARIFICATION_PROMPTS = {
    "court_name_raw": "Bạn muốn đặt sân nào?",
    "date_raw": "Bạn muốn đặt ngày nào?",
    "time_start_raw": "Bạn muốn bắt đầu lúc mấy giờ?",
    "event_name_raw": "Bạn muốn tham gia sự kiện hoặc buổi tập nào?",
    "cancel_type": "Bạn muốn hủy gì — đặt sân, buổi tập, hay đăng ký sự kiện?",
    "booking_ref_raw": "Bạn có mã đặt chỗ không? Bạn có thể tìm trong mục Đặt chỗ của tôi.",
    "booking_type": "Bạn muốn đặt sân, tham gia buổi tập, hay đăng ký sự kiện?",
}

OPTIMISTIC_MESSAGES = {
    "book_court": "Đang kiểm tra {court} cho {date} lúc {time}…",
    "book_court_partial": "Đang kiểm tra lịch trống…",
    "book_training_session": "Đang tìm buổi tập cho bạn…",
    "book_event": "Đang tìm sự kiện…",
    "cancel_booking": "Đang tìm đặt chỗ của bạn…",
    "check_availability": "Đang kiểm tra lịch trình…",
    "query_schedule": "Đang xem lịch của bạn…",
}


def _build_reply(groq_result: Dict[str, Any]) -> tuple[str, str]:
    """
    Given parsed Groq JSON, compute (reply_type, reply_message) for the frontend.
    Returns the UX routing type and the message to display.
    """
    intent = groq_result.get("intent", "unclear")
    confidence = groq_result.get("confidence", 0.0)
    noise_signal = groq_result.get("noise_signal", False)
    noise_reason = groq_result.get("noise_reason")
    clarification = groq_result.get("clarification_needed", [])
    extracted = groq_result.get("extracted", {})

    # Step 1 — Short-circuit checks (run BEFORE any DB queries)
    if noise_signal and noise_reason == "multi_speaker":
        return "noise", REPLY_NOISE_MULTI
    if noise_signal and noise_reason in ("unintelligible", "background_only"):
        return "noise", REPLY_NOISE_UNINTELLIGIBLE
    if noise_signal and noise_reason == "off_topic":
        return "off_topic", REPLY_OFF_TOPIC
    if intent == "greeting":
        return "greeting", REPLY_GREETING
    if intent == "off_topic":
        return "off_topic", REPLY_OFF_TOPIC
    if intent == "unclear" or confidence < 0.50:
        return "unclear", REPLY_UNCLEAR

    # Step 2 — Clarification needed?
    if clarification:
        first_missing = clarification[0]
        prompt = CLARIFICATION_PROMPTS.get(first_missing, f"Bạn có thể cho thêm thông tin về {first_missing} không?")
        return "clarification", prompt

    # Step 3 — Optimistic UX feedback
    if intent == "book_court":
        court = extracted.get("court_name_raw", "")
        date = extracted.get("date_raw", "")
        time = extracted.get("time_start_raw", "")
        if court and date and time:
            msg = OPTIMISTIC_MESSAGES["book_court"].format(court=court, date=date, time=time)
        else:
            msg = OPTIMISTIC_MESSAGES["book_court_partial"]
        return "optimistic", msg

    msg = OPTIMISTIC_MESSAGES.get(intent, "Đang xử lý…")
    return "optimistic", msg


async def _transcribe_audio(file_path: str) -> tuple[str, str]:
    """Send audio to Groq Whisper API, return (transcript, language)."""
    import httpx

    async with httpx.AsyncClient(timeout=15.0) as client:
        with open(file_path, "rb") as f:
            resp = await client.post(
                f"{GROQ_BASE_URL}/audio/transcriptions",
                headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                files={"file": (os.path.basename(file_path), f, "audio/mp4")},
                data={
                    "model": WHISPER_MODEL,
                    "language": "vi",
                    "response_format": "verbose_json",
                },
            )
    if resp.status_code != 200:
        logger.error("Groq transcription failed: %s %s", resp.status_code, resp.text[:300])
        raise HTTPException(status_code=502, detail="transcription_failed")

    body = resp.json()
    return body.get("text", ""), body.get("language", "vi")


async def _parse_intent_v2(transcript: str) -> Optional[Dict[str, Any]]:
    """Send transcript to Groq LLM with the v2 SCOUT system prompt. Returns raw parsed dict."""
    import httpx

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{GROQ_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": LLM_MODEL,
                "messages": [
                    {"role": "system", "content": INTENT_SYSTEM_PROMPT},
                    {"role": "user", "content": transcript},
                ],
                "temperature": 0.1,
                "max_tokens": 500,
                "response_format": {"type": "json_object"},
            },
        )
    if resp.status_code != 200:
        logger.error("Groq LLM failed: %s %s", resp.status_code, resp.text[:300])
        return None

    body = resp.json()
    try:
        raw = body["choices"][0]["message"]["content"]
        parsed = json.loads(raw)
        if not parsed:
            return None
        return parsed
    except Exception as e:
        logger.warning("Intent parse error: %s", e)
        return None


def _groq_dict_to_response(transcript: str, groq_result: Optional[Dict[str, Any]]) -> VoiceBookingResponse:
    """Convert raw Groq JSON dict into a VoiceBookingResponse with UX routing."""
    if groq_result is None:
        return VoiceBookingResponse(
            transcript=transcript,
            intent="unclear",
            confidence=0.0,
            noise_signal=True,
            noise_reason="unintelligible",
            reply_type="error",
            reply_message=REPLY_UNCLEAR,
            error_code="no_intent_found",
            error_message="Không tìm thấy thông tin trong câu nói.",
        )

    # Build extracted fields safely
    raw_extracted = groq_result.get("extracted", {})
    extracted = ExtractedFields(
        court_name_raw=raw_extracted.get("court_name_raw"),
        court_half=raw_extracted.get("court_half"),
        date_raw=raw_extracted.get("date_raw"),
        time_start_raw=raw_extracted.get("time_start_raw"),
        duration_raw=raw_extracted.get("duration_raw"),
        player_count=raw_extracted.get("player_count"),
        event_name_raw=raw_extracted.get("event_name_raw"),
        event_id_raw=raw_extracted.get("event_id_raw"),
        booking_ref_raw=raw_extracted.get("booking_ref_raw"),
        cancel_type=raw_extracted.get("cancel_type"),
    )

    reply_type, reply_message = _build_reply(groq_result)

    return VoiceBookingResponse(
        transcript=transcript,
        intent=groq_result.get("intent"),
        booking_type=groq_result.get("booking_type"),
        confidence=groq_result.get("confidence", 0.0),
        noise_signal=groq_result.get("noise_signal", False),
        noise_reason=groq_result.get("noise_reason"),
        language_detected=groq_result.get("language_detected"),
        extracted=extracted,
        clarification_needed=groq_result.get("clarification_needed", []),
        reply_type=reply_type,
        reply_message=reply_message,
    )


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/booking-intent", response_model=VoiceBookingResponse)
async def booking_intent(audio: UploadFile = File(...)):
    """
    Accept an audio recording and return transcript + booking intent.
    Supported formats: m4a, mp3, wav, webm, ogg, flac (≤10 MB).
    """
    if not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="Voice service not configured (missing GROQ_API_KEY)")

    # Validate content type
    ct = (audio.content_type or "").lower()
    if ct and ct not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail=f"invalid_audio: unsupported content type {ct}")

    # Read and validate size
    data = await audio.read()
    if len(data) > MAX_AUDIO_SIZE:
        raise HTTPException(status_code=400, detail="invalid_audio: file exceeds 10 MB limit")
    if len(data) < 1000:
        raise HTTPException(status_code=400, detail="invalid_audio: file too small, likely empty recording")

    # Write to temp file for Groq upload
    suffix = ".m4a"
    if audio.filename:
        for ext in (".wav", ".mp3", ".webm", ".ogg", ".flac"):
            if audio.filename.lower().endswith(ext):
                suffix = ext
                break

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(data)
        tmp.flush()
        tmp.close()

        # Step 1: Transcribe
        transcript, language = await _transcribe_audio(tmp.name)

        if not transcript or not transcript.strip():
            return VoiceBookingResponse(
                transcript="",
                noise_signal=True,
                noise_reason="background_only",
                reply_type="noise",
                reply_message=REPLY_NOISE_UNINTELLIGIBLE,
                error_code="no_speech",
                error_message="Không nhận được giọng nói. Vui lòng thử lại.",
            )

        # Step 2: Parse intent with v2 prompt
        groq_result = await _parse_intent_v2(transcript)
        return _groq_dict_to_response(transcript, groq_result)

    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


@router.post("/parse-intent", response_model=VoiceBookingResponse)
async def parse_intent(body: ParseIntentRequest):
    """
    Accept a text transcript (from on-device speech recognition)
    and return parsed booking intent via Groq LLM.
    """
    if not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="Voice service not configured (missing GROQ_API_KEY)")

    transcript = body.transcript.strip()
    if not transcript:
        return VoiceBookingResponse(
            transcript="",
            noise_signal=True,
            noise_reason="background_only",
            reply_type="noise",
            reply_message=REPLY_NOISE_UNINTELLIGIBLE,
            error_code="no_speech",
            error_message="Không nhận được giọng nói. Vui lòng thử lại.",
        )

    groq_result = await _parse_intent_v2(transcript)
    return _groq_dict_to_response(transcript, groq_result)
