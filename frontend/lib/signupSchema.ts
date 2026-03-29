/**
 * Signup form validation schema (Zod) + derived TypeScript type.
 *
 * Kept in a separate file so it can be imported by both the SignUpScreen
 * component and by Jest unit tests without loading any React Native code.
 */
import { z } from 'zod'
import zxcvbn from 'zxcvbn'

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
    email: z.string().trim().email('Enter a valid email address.'),
    password: z
      .string()
      .min(8, 'Min 8 characters.')
      .regex(/[0-9]/, 'Must contain at least one number.')
      .regex(/[^a-zA-Z0-9]/, 'Must contain at least one symbol.'),
    confirmPassword: z.string(),
    agree: z.boolean().refine((v) => v === true, {
      message: 'Please accept Terms of Service.',
    }),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match.',
  })
  .refine(
    (d) => {
      if (d.password.length < 8) return true // let the min-length rule fire first
      return zxcvbn(d.password).score >= 2
    },
    {
      path: ['password'],
      message: 'Password is too weak. Try mixing symbols, numbers, and words.',
    },
  )

export type SignupFormData = z.infer<typeof signupSchema>
