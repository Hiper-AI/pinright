import { Hono } from 'hono';
import { mount } from 'hono/mount';
import { legacyHandler } from './legacy.js';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));
app.all('/legacy/*', mount(legacyHandler));

export default app;
