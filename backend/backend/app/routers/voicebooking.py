"""
Voice Booking — Groq-powered speech-to-booking-intent endpoint.

Two paths:
  A) Text path (primary — uses on-device speech recognition via expo-speech-recognition):
     POST /api/speech/parse-intent  { "transcript": "..." }
     → Groq LLM parses Vietnamese text into structured booking intent.

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
from typing import Optional

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

class BookingIntent(BaseModel):
    date: Optional[str] = None          # e.g. "2025-01-15" or "thứ 7"
    time: Optional[str] = None          # e.g. "17:00"
    duration_minutes: Optional[int] = None
    court_type: Optional[str] = None    # e.g. "cầu lông", "bóng đá"
    payment_method: Optional[str] = None
    note: Optional[str] = None

class VoiceBookingResponse(BaseModel):
    transcript: str
    language: str
    intent: Optional[BookingIntent] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None

class ParseIntentRequest(BaseModel):
    transcript: str = Field(..., min_length=1, max_length=2000)

# ── Helpers ────────────────────────────────────────────────────────────────────

ALLOWED_CONTENT_TYPES = {
    "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/mpeg",
    "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg",
    "audio/flac", "video/mp4",  # some Android recorders tag m4a as video/mp4
    "application/octet-stream",  # fallback when MIME detection fails
}

INTENT_SYSTEM_PROMPT = """\
Bạn là trợ lý AI phân tích yêu cầu đặt sân thể thao từ lời nói tiếng Việt.
Hãy trích xuất thông tin đặt sân từ đoạn văn bản dưới đây và trả về JSON hợp lệ.

Các trường có thể trích xuất:
- date: ngày đặt (ISO 8601 yyyy-mm-dd, hoặc "hôm nay", "ngày mai", "thứ 2"..."chủ nhật")
- time: giờ bắt đầu (HH:MM 24h)
- duration_minutes: thời lượng thuê sân (phút, mặc định 60 nếu không nói rõ)
- court_type: loại sân (cầu lông, bóng đá, tennis, bóng rổ, bóng chuyền, pickleball)
- payment_method: phương thức thanh toán (tiền mặt, chuyển khoản, momo, zalopay)
- note: ghi chú thêm nếu có

Chỉ trả về JSON thuần, KHÔNG markdown, KHÔNG giải thích.
Nếu không trích xuất được trường nào thì bỏ qua trường đó (null).
Nếu không có thông tin đặt sân nào hết thì trả về {}.
"""


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


async def _parse_intent(transcript: str) -> Optional[BookingIntent]:
    """Send transcript to Groq LLM to extract booking intent fields."""
    import httpx
    import json

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
                "max_tokens": 300,
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
        return BookingIntent(**{k: v for k, v in parsed.items() if k in BookingIntent.model_fields})
    except Exception as e:
        logger.warning("Intent parse error: %s", e)
        return None


# ── Endpoint ───────────────────────────────────────────────────────────────────

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
                language=language,
                error_code="no_speech",
                error_message="Không nhận được giọng nói. Vui lòng thử lại.",
            )

        # Step 2: Parse intent
        intent = await _parse_intent(transcript)

        if intent is None or all(v is None for v in intent.model_dump().values()):
            return VoiceBookingResponse(
                transcript=transcript,
                language=language,
                error_code="no_intent_found",
                error_message="Không tìm thấy thông tin đặt sân trong câu nói.",
            )

        return VoiceBookingResponse(
            transcript=transcript,
            language=language,
            intent=intent,
        )
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
            language="vi",
            error_code="no_speech",
            error_message="Không nhận được giọng nói. Vui lòng thử lại.",
        )

    intent = await _parse_intent(transcript)

    if intent is None or all(v is None for v in intent.model_dump().values()):
        return VoiceBookingResponse(
            transcript=transcript,
            language="vi",
            error_code="no_intent_found",
            error_message="Không tìm thấy thông tin đặt sân trong câu nói.",
        )

    return VoiceBookingResponse(
        transcript=transcript,
        language="vi",
        intent=intent,
    )
