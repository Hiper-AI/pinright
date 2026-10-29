// Runtime smoke test for the zod4-schema task, run with tsx inside the
// agent's project (its own zod). Prints one JSON line.
const tests: { name: string; pass: boolean; got?: string }[] = [];
const t = (name: string, pass: boolean, got?: unknown) => tests.push({ name, pass, ...(pass ? {} : { got: JSON.stringify(got)?.slice(0, 200) }) });

try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('./src/signup.ts');
  const { SignupSchema, validateSignup, Role } = mod;
  const good = { email: 'a@b.co', password: 'longenough', role: 'admin', tags: { a: 'b' } };
  const ok = validateSignup(good);
  t('valid', ok?.ok === true, ok);
  t('role-enum', Role?.Admin === 'admin' && Role?.Member === 'member', Role);
  const bad = validateSignup({ email: 'nope', password: 'short', role: 'admin', tags: {}, extra: 1 });
  const msg = String(bad?.message ?? '');
  t('invalid', bad?.ok === false, bad);
  t('password-message', msg.includes('Password must be at least 8 characters'), msg);
  t('email-path', /email/i.test(msg), msg);
  t('unknown-key', /extra/.test(msg), msg);
  t('multi-line', msg.trim().includes('\n'), msg);
  t('age-int', SignupSchema.safeParse({ ...good, age: 13.5 }).success === false);
  t('age-min', SignupSchema.safeParse({ ...good, age: 12 }).success === false);
  t('age-optional', SignupSchema.safeParse(good).success === true);
  t('bad-email', SignupSchema.safeParse({ ...good, email: 'x@' }).success === false);
  t('bad-role', SignupSchema.safeParse({ ...good, role: 'owner' }).success === false);
} catch (e) {
  t('import', false, String((e as Error)?.message ?? e).slice(0, 200));
}
console.log(JSON.stringify({ tests }));
