/**
 * Signup form validation schema (Zod) + derived TypeScript type.
 *
 * Kept in a separate file so it can be imported by both the SignUpScreen
 * component and by Jest unit tests without loading any React Native code.
 */
import { z } from 'zod'
import zxcvbn from 'zxcvbn'

// Vietnam mobile: 10 digits, leading 0, second digit 3–9
const VN_PHONE_RE = /^0[3-9]\d{8}$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function isPhoneInput(v: string): boolean {
  return VN_PHONE_RE.test(v.trim())
}

export function isEmailInput(v: string): boolean {
  return EMAIL_RE.test(v.trim())
}

export const signupSchema = z
  .object({
    accountName: z
      .string()
      .trim()
      .min(1, 'Display name is required.')
      .max(50, 'Max 50 characters.')
      .regex(
        /^[\p{L}\p{M}\s'-]+$/u,
        "Name can only contain letters, spaces, hyphens, and apostrophes.",
      ),
    username: z
      .string()
      .trim()
      .min(3, 'Min 3 characters.')
      .max(20, 'Max 20 characters.')
      .regex(/^[a-z0-9_]+$/, 'Only lowercase letters, numbers, and underscores. No spaces.'),
    emailOrPhone: z
      .string()
      .trim()
      .min(1, 'Email or phone number is required.')
      .refine((v) => isEmailInput(v) || isPhoneInput(v), {
        message: 'Enter a valid email address or Vietnamese phone number (e.g. 0912345678).',
      }),
    password: z.string().optional(),
    confirmPassword: z.string().optional(),
    agree: z.boolean().refine((v) => v === true, {
      message: 'Please accept Terms of Service.',
    }),
  })
  .superRefine((d, ctx) => {
    // Password fields are required only when user entered an email (not phone)
    if (isEmailInput(d.emailOrPhone)) {
      if (!d.password || d.password.length < 8) {
        ctx.addIssue({ code: 'custom', path: ['password'], message: 'Min 8 characters.' })
      } else {
        if (!/[0-9]/.test(d.password)) {
          ctx.addIssue({ code: 'custom', path: ['password'], message: 'Must contain at least one number.' })
        }
        if (!/[^a-zA-Z0-9]/.test(d.password)) {
          ctx.addIssue({ code: 'custom', path: ['password'], message: 'Must contain at least one symbol.' })
        }
        if (d.password.length >= 8 && zxcvbn(d.password).score < 2) {
          ctx.addIssue({ code: 'custom', path: ['password'], message: 'Password is too weak. Try mixing symbols, numbers, and words.' })
        }
      }
      if (!d.confirmPassword || d.confirmPassword !== d.password) {
        ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Passwords do not match.' })
      }
    }
  })

export type SignupFormData = z.infer<typeof signupSchema>
