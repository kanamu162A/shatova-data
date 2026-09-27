// utils/validation.js
import { z } from 'zod';

/* ============================================================
   Shared helpers
   ============================================================ */
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex = /^(\+?234|0)\d{10}$/;

function normalizePhone(input) {
  let p = String(input || '').replace(/[\s\-()]/g, '');
  if (p.startsWith('+234')) p = '0' + p.slice(4);
  else if (p.startsWith('234')) p = '0' + p.slice(3);
  return p;
}

/* ============================================================
   REGISTER
   Accepts { name } OR { firstName, lastName }
   ============================================================ */
export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120).optional(),
    firstName: z.string().trim().min(1).max(60).optional(),
    lastName: z.string().trim().max(60).optional().default(''),

    phone: z
      .string()
      .trim()
      .transform(normalizePhone)
      .refine((p) => /^0\d{10}$/.test(p), 'Phone must be 11 digits starting with 0'),

    email: z.string().trim().toLowerCase().email('Invalid email address'),

    password: z.string().min(6, 'Password must be at least 6 characters').max(100),

    confirmPassword: z.string().optional(),
  })
  .refine(
    (d) => !d.confirmPassword || d.password === d.confirmPassword,
    { message: 'Passwords do not match', path: ['confirmPassword'] }
  )
  .refine((d) => !!(d.name || d.firstName), {
    message: 'Name must be at least 2 characters',
    path: ['name'],
  })
  .transform((d) => ({
    name: d.name || [d.firstName, d.lastName].filter(Boolean).join(' ').trim(),
    phone: d.phone,
    email: d.email,
    password: d.password,
  }));

/* ============================================================
   LOGIN — accepts email OR phone
   Transforms { login, password } → { identifier, isEmail, password }
   ============================================================ */
export const loginSchema = z
  .object({
    login: z
      .string()
      .trim()
      .min(1, 'Email or phone is required')
      .refine(
        (v) => emailRegex.test(v) || phoneRegex.test(v),
        'Enter a valid email or phone number'
      ),
    password: z.string().min(1, 'Password is required'),
  })
  .transform((d) => {
    const isEmail = d.login.includes('@');
    if (isEmail) {
      return {
        identifier: d.login.toLowerCase(),
        isEmail: true,
        password: d.password,
      };
    }
    return {
      identifier: normalizePhone(d.login),
      isEmail: false,
      password: d.password,
    };
  });

/* ============================================================
   SET PIN
   ------------------------------------------------------------
   The frontend already does the "confirm PIN" step client-side.
   Backend validates:
     • pin is 4 digits
     • if confirmPin is provided, they must match
   ============================================================ */
export const setPinSchema = z
  .object({
    pin: z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits'),
    confirmPin: z
      .string()
      .regex(/^\d{4}$/, 'Confirm PIN must be exactly 4 digits')
      .optional(),
  })
  .refine((d) => !d.confirmPin || d.pin === d.confirmPin, {
    message: 'PINs do not match',
    path: ['confirmPin'],
  });

/* ============================================================
   VERIFY PIN
   ============================================================ */
export const verifyPinSchema = z.object({
  pin: z.string().regex(/^\d{4}$/, 'PIN must be 4 digits'),
});

/* ============================================================
   FORGOT PASSWORD
   ============================================================ */
export const forgotPasswordSchema = z.object({
  identifier: z.string().min(3, 'Enter your phone or email'),
});

/* ============================================================
   RESET PASSWORD
   ============================================================ */
export const resetPasswordSchema = z
  .object({
    userId: z.union([z.number(), z.string()]).transform((v) => Number(v)),
    token: z.string().min(10, 'Invalid token'),
    newPassword: z.string().min(6, 'Password must be at least 6 characters').max(100),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

/* ============================================================
   CHANGE PASSWORD
   ============================================================ */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password required'),
    newPassword: z.string().min(6, 'New password must be at least 6 characters').max(100),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

/* ============================================================
   VALIDATE HELPER — crash-safe across Zod versions
   ============================================================ */
export function validate(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error?.issues || result.error?.errors || [];
    const first = issues[0] || {};
    const message = first.message || 'Invalid input';
    const path = Array.isArray(first.path) && first.path.length
      ? first.path.join('.')
      : null;
    return { ok: false, message: path ? `${path}: ${message}` : message };
  }
  return { ok: true, data: result.data };
}