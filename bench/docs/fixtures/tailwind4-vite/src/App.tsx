export default function App() {
  return (
    <div className="content-auto bg-brand font-display dark:bg-gray-900">
      <div className="bg-black/50 text-brand">Overlay</div>
      <button onClick={() => document.documentElement.classList.toggle('dark')}>Toggle dark</button>
    </div>
  );
}
