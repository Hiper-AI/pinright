import { openai } from '@ai-sdk/openai';
import { convertToModelMessages, createUIMessageStreamResponse, isStepCount, streamText, tool, toUIMessageStream, type UIMessage } from 'ai';
import { z } from 'zod';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const result = streamText({
    model: openai('gpt-4o-mini'),
    instructions: 'You are a terse assistant.',
    messages: await convertToModelMessages(messages),
    tools: {
      getWeather: tool({
        description: 'Get the temperature in a city',
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, temperature: 21 }),
      }),
    },
    stopWhen: isStepCount(5),
  });
  return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) });
}
