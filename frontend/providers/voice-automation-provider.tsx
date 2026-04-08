/**
 * Voice Automation Provider
 *
 * Manages the full voice booking flow:
 *   idle → listening → processing → result → idle
 *
 * Uses on-device speech recognition (expo-speech-recognition) for transcription,
 * then sends text to backend Groq LLM for intent parsing.
 */

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition'

import { API_BASE_URL } from '@/env'
import { useVoicePreference } from '@/hooks/use-voice-preference'

// ── Types ─────────────────────────────────────────────────────────────────────

export type VoiceFlowState = 'idle' | 'listening' | 'processing' | 'result' | 'error'

export type VoiceIntentType =
  | 'book_court'
  | 'book_training_session'
  | 'book_event'
  | 'cancel_booking'
  | 'check_availability'
  | 'query_schedule'
  | 'greeting'
  | 'off_topic'
  | 'unclear'

export type VoiceBookingType = 'court' | 'training_session' | 'event'

export type VoiceReplyType =
  | 'noise'
  | 'greeting'
  | 'off_topic'
  | 'unclear'
  | 'clarification'
  | 'optimistic'
  | 'error'

export interface ExtractedFields {
  court_name_raw?: string | null
  court_half?: boolean | null
  date_raw?: string | null
  time_start_raw?: string | null
  duration_raw?: string | null
  player_count?: number | null
  event_name_raw?: string | null
  event_id_raw?: string | null
  booking_ref_raw?: string | null
  cancel_type?: string | null
}

export interface VoiceResult {
  transcript: string
  intent: VoiceIntentType | null
  booking_type: VoiceBookingType | null
  confidence: number
  noise_signal: boolean
  noise_reason?: string | null
  language_detected?: string | null
  extracted: ExtractedFields | null
  clarification_needed: string[]
  reply_type: VoiceReplyType | null
  reply_message: string | null
  error_code?: string | null
  error_message?: string | null
}

interface VoiceAutomationContextValue {
  /** Whether voice feature is enabled in settings */
  enabled: boolean
  /** Current flow state */
  flowState: VoiceFlowState
  /** Partial transcript while listening */
  partialTranscript: string
  /** Final result after processing */
  result: VoiceResult | null
  /** Status messages during processing */
  statusMessage: string
  /** Start voice listening */
  startListening: () => Promise<void>
  /** Stop listening and process */
  stopListening: () => void
  /** Cancel / reset to idle */
  dismiss: () => void
  /** Apply intent and reset */
  applyAndReset: () => void
}

const VoiceAutomationContext = createContext<VoiceAutomationContextValue>({
  enabled: false,
  flowState: 'idle',
  partialTranscript: '',
  result: null,
  statusMessage: '',
  startListening: async () => {},
  stopListening: () => {},
  dismiss: () => {},
  applyAndReset: () => {},
})

export const useVoiceAutomation = () => useContext(VoiceAutomationContext)

// ── Provider ──────────────────────────────────────────────────────────────────

export function VoiceAutomationProvider({ children }: { children: React.ReactNode }) {
  const { enabled } = useVoicePreference()

  const [flowState, setFlowState] = useState<VoiceFlowState>('idle')
  const [partialTranscript, setPartialTranscript] = useState('')
  const [result, setResult] = useState<VoiceResult | null>(null)
  const [statusMessage, setStatusMessage] = useState('')

  // Track the final transcript from speech recognition
  const finalTranscriptRef = useRef('')

  // ── Speech recognition event handlers ─────────────────────────────────

  useSpeechRecognitionEvent('result', (event) => {
    const text = event.results?.[0]?.transcript ?? ''
    if (event.isFinal) {
      finalTranscriptRef.current = text
      // Auto-process when speech recognition gives final result
      processTranscript(text)
    } else {
      setPartialTranscript(text)
    }
  })

  useSpeechRecognitionEvent('error', (event) => {
    console.warn('[Voice] Recognition error:', event.error)
    if (flowState === 'listening') {
      setFlowState('error')
      setResult({
        transcript: '',
        intent: null,
        booking_type: null,
        confidence: 0,
        noise_signal: true,
        extracted: null,
        clarification_needed: [],
        reply_type: 'error',
        reply_message: 'Không nhận được giọng nói. Vui lòng thử lại.',
        error_code: 'recognition_failed',
        error_message: 'Không nhận được giọng nói. Vui lòng thử lại.',
      })
    }
  })

  useSpeechRecognitionEvent('end', () => {
    // If we're still in listening state when recognition ends (e.g. timeout),
    // process whatever we have
    if (flowState === 'listening' && finalTranscriptRef.current) {
      processTranscript(finalTranscriptRef.current)
    }
  })

  // ── Process transcript via backend ────────────────────────────────────

  const processTranscript = useCallback(async (transcript: string) => {
    if (!transcript.trim()) {
      setFlowState('error')
      setResult({
        transcript: '',
        intent: null,
        booking_type: null,
        confidence: 0,
        noise_signal: true,
        extracted: null,
        clarification_needed: [],
        reply_type: 'noise',
        reply_message: 'Không nhận được giọng nói. Vui lòng thử lại.',
        error_code: 'no_speech',
        error_message: 'Không nhận được giọng nói. Vui lòng thử lại.',
      })
      return
    }

    setFlowState('processing')
    setStatusMessage('Đang phân tích yêu cầu...')

    try {
      const resp = await fetch(`${API_BASE_URL}/speech/parse-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
      })

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'Unknown error')
        throw new Error(errText)
      }

      const data = await resp.json()

      const voiceResult: VoiceResult = {
        transcript: data.transcript ?? transcript,
        intent: data.intent ?? null,
        booking_type: data.booking_type ?? null,
        confidence: data.confidence ?? 0,
        noise_signal: data.noise_signal ?? false,
        noise_reason: data.noise_reason ?? null,
        language_detected: data.language_detected ?? null,
        extracted: data.extracted ?? null,
        clarification_needed: data.clarification_needed ?? [],
        reply_type: data.reply_type ?? null,
        reply_message: data.reply_message ?? null,
        error_code: data.error_code ?? null,
        error_message: data.error_message ?? null,
      }

      setResult(voiceResult)

      // Determine flow state based on reply_type
      const rt = voiceResult.reply_type
      if (rt === 'error' || rt === 'noise') {
        setFlowState('error')
      } else {
        setFlowState('result')
      }

      // Update status message for optimistic feedback
      if (rt === 'optimistic' && voiceResult.reply_message) {
        setStatusMessage(voiceResult.reply_message)
      } else {
        setStatusMessage('')
      }
    } catch (err: any) {
      console.error('[Voice] Parse intent failed:', err)
      setFlowState('error')
      setResult({
        transcript,
        intent: null,
        booking_type: null,
        confidence: 0,
        noise_signal: false,
        extracted: null,
        clarification_needed: [],
        reply_type: 'error',
        reply_message: 'Không thể kết nối máy chủ. Vui lòng thử lại.',
        error_code: 'network_error',
        error_message: 'Không thể kết nối máy chủ. Vui lòng thử lại.',
      })
      setStatusMessage('')
    }
  }, [])

  // ── Public actions ────────────────────────────────────────────────────

  const startListening = useCallback(async () => {
    // Request permission
    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
    if (!granted) {
      setFlowState('error')
      setResult({
        transcript: '',
        intent: null,
        booking_type: null,
        confidence: 0,
        noise_signal: false,
        extracted: null,
        clarification_needed: [],
        reply_type: 'error',
        reply_message: 'Cần quyền truy cập micro để sử dụng tính năng giọng nói.',
        error_code: 'permission_denied',
        error_message: 'Cần quyền truy cập micro để sử dụng tính năng giọng nói.',
      })
      return
    }

    // Reset state
    finalTranscriptRef.current = ''
    setPartialTranscript('')
    setResult(null)
    setStatusMessage('')
    setFlowState('listening')

    // Start recognition
    ExpoSpeechRecognitionModule.start({
      lang: 'vi-VN',
      interimResults: true,
      maxAlternatives: 1,
    })
  }, [])

  const stopListening = useCallback(() => {
    ExpoSpeechRecognitionModule.stop()
    // The 'end' event handler will trigger processing
  }, [])

  const dismiss = useCallback(() => {
    if (flowState === 'listening') {
      ExpoSpeechRecognitionModule.abort()
    }
    setFlowState('idle')
    setPartialTranscript('')
    setResult(null)
    setStatusMessage('')
  }, [flowState])

  const applyAndReset = useCallback(() => {
    // The consumer reads `result` before calling this
    setFlowState('idle')
    setPartialTranscript('')
    setResult(null)
    setStatusMessage('')
  }, [])

  // ── Context value ─────────────────────────────────────────────────────

  const value = useMemo<VoiceAutomationContextValue>(() => ({
    enabled,
    flowState,
    partialTranscript,
    result,
    statusMessage,
    startListening,
    stopListening,
    dismiss,
    applyAndReset,
  }), [enabled, flowState, partialTranscript, result, statusMessage, startListening, stopListening, dismiss, applyAndReset])

  return (
    <VoiceAutomationContext.Provider value={value}>
      {children}
    </VoiceAutomationContext.Provider>
  )
}
