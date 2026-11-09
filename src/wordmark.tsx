// The app's name in the hero: real text in the design system's typeface, so it reads,
// scales and translates like any other words (it was an outlined SVG of the old name).
export function Wordmark({ className }: { className?: string }) {
  return <span className={`text-[1.75rem] leading-none font-extrabold tracking-tight max-sm:text-2xl ${className ?? ""}`}>Pitch & Tempo</span>
}
