import { createServer } from 'node:http';

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ greeting: process.env.GREETING }));
});

server.listen(Number(process.env.PORT));
