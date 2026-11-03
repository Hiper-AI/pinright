export async function getUser(id: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`https://api.example.com/users/${id}`);
  return (await res.json()) as { id: string; name: string };
}

export async function getRepoStars(owner: string, name: string): Promise<number> {
  const res = await fetch('https://api.example.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'query RepoStars($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { stars } }',
      variables: { owner, name },
    }),
  });
  const body = (await res.json()) as { data: { repository: { stars: number } } };
  return body.data.repository.stars;
}
