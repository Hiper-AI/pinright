import express from 'express';

const app = express();
app.use(express.json());

async function findUser(id) {
  if (id === 'boom') throw new Error('lookup failed');
  return { id };
}

app.get('/files/*splat', (req, res) => {
  res.json({ path: req.params.splat.join('/') });
});

app.get('/docs/:name{.:ext}', (req, res) => {
  res.json(req.params.ext ? { name: req.params.name, ext: req.params.ext } : { name: req.params.name });
});

app.get('/users/:id', async (req, res) => {
  res.json(await findUser(req.params.id));
});

app.post('/users', (req, res) => {
  res.status(201).json({ id: 1, ...req.body });
});

app.use((err, req, res, _next) => {
  res.status(500).json({ error: err.message });
});

export default app;
