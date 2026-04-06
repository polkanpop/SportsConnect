# Voice Booking Feature — Technical Reference

## Architecture
```
[User speaks Vietnamese]
        ↓
expo-speech-recognition (on-device, vi-VN)
        ↓ text transcript
[Frontend] POST /api/speech/parse-intent { transcript, language: "vi" }
        ↓
[Backend] Groq LLM (llama-3.1-8b-instant)
        ↓ structured JSON intent
[Frontend] Display result → Apply to booking form
```

## Frontend Components

### FloatingVoiceButton (`components/voice/FloatingVoiceButton.tsx`)
- 56×56 draggable FAB with PanResponder
- Snaps to screen edges with spring animation
- Bounce effect on tap (scale 0.8 → 1.0 spring)
- PNG mic icon (not Ionicons — they render empty on device)
- Auth-gated: only shows for logged-in users
- Only shows when `flowState === 'idle'` (overlay handles other states)

### VoiceFocusOverlay (`components/voice/VoiceFocusOverlay.tsx`)
- Full-screen dark overlay (rgba 0,0,0,0.85) with fade-in (300ms)
- States: listening → processing → result → error
- Listening: Pulsing mic circle, partial transcript display
- Processing: Spinner + status message
- Result: Intent summary card with Apply/Retry buttons
- Error: Error message with Retry/Close
- All icons use PNG Image (ICONS.mic, ICONS.closeMenu, ICONS.check, ICONS.cancelEdit)

### VoiceAutomationProvider (`providers/voice-automation-provider.tsx`)
- Context provider wrapping the voice state machine
- Manages: flowState, partialTranscript, result, statusMessage
- Handles: startListening, stopListening, dismiss, applyAndReset
- Permission: expo-speech-recognition ExpoSpeechRecognitionModule

### useVoicePreference (`hooks/use-voice-preference.ts`)
- AsyncStorage-persisted on/off toggle (@voice_automation_enabled)
- Module-level shared state with broadcast pattern
- Multiple hook instances stay in sync via listener set
- OFF by default (Beta feature)

## Backend Endpoint
```
POST /api/speech/parse-intent
Body: { "transcript": "Đặt sân cầu lông 3 giờ chiều", "language": "vi" }
Response: {
  "intent": {
    "court_type": "cầu lông",
    "time": "15:00",
    "date": null,
    "duration_minutes": null,
    "payment_method": null,
    "note": null
  },
  "transcript": "...",
  "confidence": 0.85
}
```

## Groq Models
| Model | Role | Rate Limit | Cost |
|-------|------|------------|------|
| whisper-large-v3-turbo | STT (future: audio upload) | 400K audio-sec/hr, 400 RPM | $0.04/hr |
| llama-3.1-8b-instant | Intent parsing | 30 RPM, 131K context | $0.05/$0.08 per 1M tokens |

## Permission Flow
1. User toggles voice ON in Account Settings
2. `ExpoSpeechRecognitionModule.getPermissionsAsync()` checks
3. If not granted → `requestPermissionsAsync()` system dialog
4. If denied → toggle stays off, no enable
5. If granted → setEnabled(true), FAB appears

## Known Issues & Fixes
- **Ionicons empty on device**: All `@expo/vector-icons` Ionicons render as empty squares in OTA builds. Fixed by replacing with `<Image source={ICONS.xxx}>` PNG icons.
- **FAB on auth pages**: FloatingVoiceButton rendered outside Stack in _layout.tsx. Fixed with `useAuthContext().isLoggedIn` gate.
- **No bounce on tap**: Added Animated.spring scale-down (0.8) on press + spring-back (1.0) for tactile feedback.
- **Overlay instant appear**: Added Animated.timing fade-in (opacity 0→1, 300ms) on mount.
