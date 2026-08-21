import { useEffect, useRef, useState } from "react"

// How long a run lasted, in whole seconds — measured on the falling edge, so
// the value appears once and then holds. Nothing ticks while it runs: the
// number is only ever read after the fact, and a per-second re-render of a
// streaming thread would cost far more than it shows.
export const useElapsedSeconds = (isRunning: boolean): number | undefined => {
  const [seconds, setSeconds] = useState<number | undefined>(undefined)
  const startedAt = useRef<number | null>(null)

  useEffect(() => {
    if (isRunning) {
      startedAt.current ??= Date.now()
      return
    }
    if (startedAt.current === null) return
    setSeconds(Math.ceil((Date.now() - startedAt.current) / 1000))
    startedAt.current = null
  }, [isRunning])

  return seconds
}
