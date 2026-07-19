// @vitest-environment happy-dom
import { describe, test, expect, vi } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import ConfigStatusBar from './ConfigStatusBar.js'

// Stub children to keep this test focused on cwdName / sessionCwd rendering.
vi.mock('./ModelStatusButton', () => ({ default: () => null }))
vi.mock('./ModeStatusButton', () => ({ default: () => null }))
vi.mock('./TaskDock', () => ({ TaskDock: () => null }))

describe('ConfigStatusBar with sessionCwd', () => {
  test('renders basename when sessionCwd provided', () => {
    render(
      <ConfigStatusBar
        cwdName="fallback-name"
        branch="main"
        sessionCwd="/Users/ethan/code/proj/subdir"
        onTaskSelect={() => {}}
      />
    )
    expect(screen.getByText('subdir')).toBeInTheDocument()
    expect(screen.queryByText('fallback-name')).not.toBeInTheDocument()
  })

  test('falls back to cwdName when sessionCwd undefined', () => {
    render(
      <ConfigStatusBar
        cwdName="static-fallback"
        branch="main"
        onTaskSelect={() => {}}
      />
    )
    expect(screen.getByText('static-fallback')).toBeInTheDocument()
  })

  test('handles sessionCwd = "/"', () => {
    render(
      <ConfigStatusBar cwdName="fallback" branch="main" sessionCwd="/" onTaskSelect={() => {}} />
    )
    // basename('/') === '/' (filter(Boolean) empties the array; pop() returns undefined; fallback to input)
    expect(screen.getByText('/')).toBeInTheDocument()
  })
})