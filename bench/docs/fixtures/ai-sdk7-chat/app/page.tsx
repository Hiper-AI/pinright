'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

export default function Page() {
  const { messages, sendMessage } = useChat();
  const [text, setText] = useState('');
  return (
    <main>
      {messages.map((m) => (
        <div key={m.id}>
          {m.role}: {m.parts.map((p, i) => (p.type === 'text' ? <span key={i}>{p.text}</span> : null))}
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage({ text });
          setText('');
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </form>
    </main>
  );
}
