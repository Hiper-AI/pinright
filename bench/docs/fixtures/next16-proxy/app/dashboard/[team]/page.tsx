import { cookies } from 'next/headers';

export default async function Page({ params }: { params: Promise<{ team: string }> }) {
  const { team } = await params;
  const theme = (await cookies()).get('theme')?.value ?? 'light';
  return (
    <main>
      <h1>Team: {team}</h1>
      <p>Theme: {theme}</p>
    </main>
  );
}
