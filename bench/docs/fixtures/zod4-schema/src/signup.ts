import { z } from 'zod';

export enum Role {
  Admin = 'admin',
  Member = 'member',
}

export const SignupSchema = z.strictObject({
  email: z.email(),
  password: z.string().min(8, { error: 'Password must be at least 8 characters' }),
  age: z.int().min(13).optional(),
  role: z.enum(Role),
  tags: z.record(z.string(), z.string()),
});

export function validateSignup(input: unknown) {
  const r = SignupSchema.safeParse(input);
  return r.success ? { ok: true as const, data: r.data } : { ok: false as const, message: z.prettifyError(r.error) };
}
