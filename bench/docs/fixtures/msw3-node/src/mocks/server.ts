import { setupServer } from 'msw/node';
import { handlers } from './handlers.js';

export const server = setupServer(...handlers);

export function startMocks(): void {
  server.listen({ onUnhandledFrame: 'error' });
}
