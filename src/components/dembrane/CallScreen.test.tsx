/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CallScreen } from './CallScreen'

/**
 * The drawer, replaced by something that records the props it was handed on
 * every render. vaul itself does nothing observable in jsdom — it measures the
 * sheet and writes transforms — so what these tests check is the props it is
 * given, which is where the bug was.
 */
const snapPointsSeen: unknown[] = []
vi.mock('@/components/ui/shadcn/drawer', () => ({
  Drawer: ({ snapPoints, children }: { snapPoints: unknown; children: React.ReactNode }) => {
    snapPointsSeen.push(snapPoints)
    return <div>{children}</div>
  },
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

afterEach(() => {
  snapPointsSeen.length = 0
  cleanup()
})

describe('CallScreen', () => {
  /**
   * vaul re-runs its snap effect whenever the `snapPoints` array changes
   * identity, and that effect writes the transform back to the active snap
   * point. A fresh array on every render therefore cancels a drag in progress:
   * while the call was live the transcript grew every few seconds, so the
   * drawer could only be dragged back down once muting stopped the updates.
   */
  it('keeps one snap points array while the transcript grows', () => {
    const { rerender } = render(<CallScreen title="Test call" transcript="one" />)
    rerender(<CallScreen title="Test call" transcript="one two" />)
    rerender(<CallScreen title="Test call" transcript="one two three" />)

    expect(snapPointsSeen.length).toBeGreaterThanOrEqual(3)
    expect(new Set(snapPointsSeen).size).toBe(1)
  })
})
