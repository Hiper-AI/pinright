import * as z from 'zod';

export const EventSchema = z.object({
  id: z.uuid(),
  type: z.enum(['click', 'view']),
  at: z.iso.datetime(),
  props: z.record(z.string(), z.union([z.string(), z.number()])),
});

export type Event = z.infer<typeof EventSchema>;

const CompiledEvent = z.compile(EventSchema);

export function parseEvents(lines: string[]): Event[] {
  return lines.map((line) => CompiledEvent.parse(JSON.parse(line)));
}
