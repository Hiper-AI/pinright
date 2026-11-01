import { describe, expect, it } from 'vitest';
import { refFromId } from '../src/mcp.js';

describe('get-docs library ids', () => {
  it('takes ecosystem and name from our ids', async () => {
    expect(await refFromId('npm:next@16.4.3')).toEqual({ ecosystem: 'npm', name: 'next', version: '16.4.3' });
    expect(await refFromId('pypi:pydantic')).toEqual({ ecosystem: 'pypi', name: 'pydantic' });
  });

  it('lets an explicit ecosystem or packageName override the id (seen in benchmark runs)', async () => {
    // The agent sent these and got the docs of the npm packages "pydantic" and "placeholder".
    expect(await refFromId('npm:pydantic', 'pypi')).toEqual({ ecosystem: 'pypi', name: 'pydantic' });
    expect(await refFromId('npm:placeholder', 'pypi', 'langchain')).toEqual({ ecosystem: 'pypi', name: 'langchain' });
    expect(await refFromId('npm:zod@4.6.7', 'not-a-registry', ' ')).toEqual({ ecosystem: 'npm', name: 'zod', version: '4.6.7' });
  });
});
