import { graphql } from 'msw/graphql';
import { http, HttpResponse } from 'msw/http';

const api = graphql.link('https://api.example.com/graphql');

export const handlers = [
  http.get('https://api.example.com/users/:id', ({ params }) => HttpResponse.json({ id: params.id, name: 'Ada' })),
  api.query('RepoStars', () => HttpResponse.json({ data: { repository: { stars: 42 } } })),
];
